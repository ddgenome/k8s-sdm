/*
 * Copyright © 2019 Atomist, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
    Configuration,
    GitProject,
} from "@atomist/automation-client";
import {
    encodeSecret,
    KubernetesApplication,
    KubernetesDeploy,
} from "@atomist/sdm-pack-k8s";
import * as k8s from "@kubernetes/client-node";
import * as _ from "lodash";
import { DeepPartial } from "ts-essentials";
import { kubeConfigContext } from "./config";

/**
 * Augment the Kubernetes application object in a manner suitable for deploying this SDM.  Specifically,
 *
 * -   Set application namespace to "sdm".
 * -   Set the environment variable ATOMIST_GOAL_LAUNCHER to "kubernetes".
 * -   Add adequate SDM config as secret to application data and add the
 *     use of the secret in the deploymentSpec.
 * -   If the Kubernetes context is "minikube", add nginx-ingress
 *     controller annotations to ingress.
 *
 * The user client.config.json will be the basis of the SDM
 * configuration.  If that cannot be read, a minimal configuration
 * with an API key, workspace ID, and unique name will be created.
 *
 * @param app Current value of application data
 * @param p Project being deployed
 * @param goal Kubernetes deployment goal
 * @return Augmented Kubernetes application data.
 */
export async function selfDeployAppData(app: KubernetesApplication, p: GitProject, goal: KubernetesDeploy): Promise<KubernetesApplication> {
    app.ns = "sdm";
    const kubeContext = kubeConfigContext();
    const k8sApp = addSecret(app, goal, kubeContext);
    return localIngress(k8sApp, kubeContext);
}

/**
 * Create the an SDM confiugration and add it as a secret in the
 * application data.  Needed configuration properties will be selected
 * from `goal.sdm.configuration`, specifically:
 *
 * -   `name`: SDM `configuration.name` + "_" + `app.ns`
 * -   `apiKey`: SDM `configuration.apiKey`
 * -   `workspaceIds`: `[app.workspaceId]`
 * -   `environment`: `context` or SDM `configuration.environment`
 * -   `sdm.build`: SDM `configuration.sdm.build`
 *
 * The configuration will then be converted into a Kubernetes secret
 * and added to the application data.  The secret name will be
 * `app.name` and the key in the secret data containing the encoded
 * configuration will be [[sdmSecretConfigKey]].
 *
 * The proper secret configuration will be added to the `app.deploymentSpec`.
 *
 * Note: Since this goal is only enabled when running locally to
 * deploy itself, using current active SDM configuration is
 * appropriate.
 *
 * @param app Current value of application data
 * @param config the user configuration.
 * @param kubeContext Kubernetes config context, typically something representing the name of Kubernetes cluster.
 * @return Kubernetes application data with SDM configuration as secret.
 */
export function addSecret(app: KubernetesApplication, goal: KubernetesDeploy, kubeContext: string): KubernetesApplication {
    const secretApp = _.merge({ deploymentSpec: { spec: { template: { spec: { containers: [{}] } } } } }, app);
    const cluster = kubeContext || goal.details.environment || goal.sdm.configuration.environment;
    const config: Configuration = {
        name: goal.sdm.configuration.name + "_" + cluster,
        apiKey: goal.sdm.configuration.apiKey,
        workspaceIds: [secretApp.workspaceId],
        environment: cluster,
        cluster: {
            workers: 2,
        },
    };
    const secretData: { [key: string]: string } = {};
    const sdmSecretConfigKey = "client.config.json";
    secretData[sdmSecretConfigKey] = JSON.stringify(config);
    const configSecret = encodeSecret(secretApp.name, secretData);
    if (secretApp.secrets) {
        secretApp.secrets.push(configSecret);
    } else {
        secretApp.secrets = [configSecret];
    }

    const secretVolume = {
        name: secretApp.name,
        secret: {
            defaultMode: 256,
            secretName: secretApp.name,
        },
    };
    if (secretApp.deploymentSpec.spec.template.spec.volumes) {
        secretApp.deploymentSpec.spec.template.spec.volumes.push(secretVolume);
    } else {
        secretApp.deploymentSpec.spec.template.spec.volumes = [secretVolume];
    }
    const volumeMount = {
        mountPath: "/opt/atm",
        name: secretVolume.name,
        readOnly: true,
    };
    if (secretApp.deploymentSpec.spec.template.spec.containers[0].volumeMounts) {
        secretApp.deploymentSpec.spec.template.spec.containers[0].volumeMounts.push(volumeMount);
    } else {
        secretApp.deploymentSpec.spec.template.spec.containers[0].volumeMounts = [volumeMount];
    }
    const secretEnv = {
        name: "ATOMIST_CONFIG_PATH",
        value: `${volumeMount.mountPath}/${sdmSecretConfigKey}`,
    };
    if (secretApp.deploymentSpec.spec.template.spec.containers[0].env) {
        secretApp.deploymentSpec.spec.template.spec.containers[0].env.push(secretEnv);
    } else {
        secretApp.deploymentSpec.spec.template.spec.containers[0].env = [secretEnv];
    }

    return secretApp;
}

/**
 * If deploying an application to a local cluster, make sure there is
 * an ingress with the appropriate nginx-ingress annotations.
 * Currently, only minikube clusters are considered local.
 *
 * @param app Kubernetes application data
 * @param context Current Kubernetes configuration context
 * @return Kubernetes application data, possibly with new annotations on the ingressSpec
 */
export function localIngress(app: KubernetesApplication, context: string): KubernetesApplication {
    if (context !== "minikube") {
        return app;
    }
    app.path = `/${app.ns}/${app.name}`;
    app.protocol = "http";
    const ingressSpec: DeepPartial<k8s.V1beta1Ingress> = {
        metadata: {
            annotations: {
                "kubernetes.io/ingress.class": "nginx",
                "nginx.ingress.kubernetes.io/rewrite-target": "/",
                "nginx.ingress.kubernetes.io/ssl-redirect": "false",
            },
        },
    };
    app.ingressSpec = _.merge(ingressSpec, app.ingressSpec);
    return app;
}
