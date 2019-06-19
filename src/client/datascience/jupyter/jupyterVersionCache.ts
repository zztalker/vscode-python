// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';
import { inject, injectable } from 'inversify';

import { Resource } from '../../../client/common/types';
import { IWorkspaceService } from '../../common/application/types';
import { IDisposableRegistry, IConfigurationService } from '../../common/types';
import { IInterpreterService } from '../../interpreter/contracts';
import { IJupyterExecution, IJupyterVersion, IJupyterVersionCache } from '../types';
import { createDeferred, Deferred } from '../../common/utils/async';
import { Settings } from '../constants';

@injectable()
export class JupyterVersionCache implements IJupyterVersionCache {

    private localVersions: Deferred<IJupyterVersion[]> = createDeferred<IJupyterVersion[]>();
    private remoteVersions: Deferred<IJupyterVersion[]> = createDeferred<IJupyterVersion[]>();

    constructor(
        @inject(IDisposableRegistry) private disposableRegistry: IDisposableRegistry,
        @inject(IInterpreterService) private interpreterService: IInterpreterService,
        @inject(IConfigurationService) private configService: IConfigurationService,
        @inject(IJupyterExecution) private execution : IJupyterExecution
    ) {
        // Wait for the interpreter service to be done for locals. 
        this.interpreterService.hasInterpreters.then(this.haveInterpreters.bind(this)).ignoreErrors();
        this.disposableRegistry.push(this.interpreterService.onDidChangeInterpreter(this.haveInterpreters.bind(this)));

        // For remote, do right now if there's a remote server URI
        this.serverUriChanged();
        this.configService.getSettings().onDidChange(this.serverUriChanged.bind(this));
    }

    public async get(resource: Resource): Promise<IJupyterVersion | undefined> {
        let found: IJupyterVersion | undefined;

        // Wait for all of the versions to be fetched
        const versions = this.isRemote ? await this.remoteVersions.promise : await this.localVersions.promise;

        // Find the interpreter for this resource
        const current = await this.interpreterService.getActiveInterpreter(resource);

        // Find the closest match
        if (current && current.version) {
            let bestScore = -1;
            for (const entry of versions) {
                let currentScore = 0;
                if (!entry) {
                    continue;
                }
                // Interpreter based (local)
                const interpreter = entry.interpreter;
                const version = interpreter ? interpreter.version : undefined;
                if (version) {
                    if (version.major === current.version.major) {
                        currentScore += 4;
                        if (version.minor === current.version.minor) {
                            currentScore += 2;
                            if (version.patch === current.version.patch) {
                                currentScore += 1;
                            }
                        }
                    }
                }
                // Kernel based (remote)
                const kernelSpec = entry.spec;
                if (kernelSpec) {
                    // We're assuming this is python based
                    currentScore += 1;
                }
                if (currentScore > bestScore) {
                    found = entry;
                    bestScore = currentScore;
                }
            }
        } else {
            // Just pick the first one
            found = versions.find(f => f !== undefined);
        }

        return found;
    }

    public getAll(): Promise<IJupyterVersion[]> {
        if (this.isRemote) {
            return this.remoteVersions.promise;
        } else {
            return this.localVersions.promise;
        }
    }

    private get isRemote() : boolean {
        const settings = this.configService.getSettings();
        return settings && settings.datascience.jupyterServerURI !== undefined && settings.datascience.jupyterServerURI !== Settings.JupyterServerLocalLaunch;
    }

    private async haveInterpreters() : Promise<void> {
        // We have all of the interpreters. We can now ask for all of the versions
        const versions = await this.execution.enumerateVersions();
        this.localVersions.resolve(versions);
    }

    private async serverUriChanged() : Promise<void> {
        this.remoteVersions = createDeferred<IJupyterVersion[]>();
        const settings = this.configService.getSettings();
        if (settings && settings.datascience.jupyterServerURI && settings.datascience.jupyterServerURI !== Settings.JupyterServerLocalLaunch) {
            const versions = await this.execution.enumerateVersions(settings.datascience.jupyterServerURI);
            this.remoteVersions.resolve(versions);
        } else {
            this.remoteVersions.resolve([]);
        }
    }
}
