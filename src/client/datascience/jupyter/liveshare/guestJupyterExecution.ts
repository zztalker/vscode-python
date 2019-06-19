// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';
import { injectable } from 'inversify';
import * as uuid from 'uuid/v4';
import { CancellationToken } from 'vscode';

import { ILiveShareApi, IWorkspaceService } from '../../../common/application/types';
import { IFileSystem } from '../../../common/platform/types';
import { IProcessServiceFactory, IPythonExecutionFactory } from '../../../common/process/types';
import { IAsyncDisposableRegistry, IConfigurationService, IDisposableRegistry, ILogger } from '../../../common/types';
import * as localize from '../../../common/utils/localize';
import { noop } from '../../../common/utils/misc';
import { IInterpreterService, IKnownSearchPathsForInterpreters } from '../../../interpreter/contracts';
import { IServiceContainer } from '../../../ioc/types';
import { LiveShare, LiveShareCommands } from '../../constants';
import {
    IConnection,
    IJupyterCommandFactory,
    IJupyterSessionManager,
    IJupyterVersion,
    INotebookServer,
    INotebookServerOptions
} from '../../types';
import { JupyterConnectError } from '../jupyterConnectError';
import { JupyterExecutionBase } from '../jupyterExecution';
import { GuestJupyterSessionManager } from './guestJupyterSessionManager';
import { LiveShareParticipantGuest } from './liveShareParticipantMixin';
import { ServerCache } from './serverCache';

// This class is really just a wrapper around a jupyter execution that also provides a shared live share service
@injectable()
export class GuestJupyterExecution extends LiveShareParticipantGuest(JupyterExecutionBase, LiveShare.JupyterExecutionService) {
    private serverCache : ServerCache;

    constructor(
        liveShare: ILiveShareApi,
        executionFactory: IPythonExecutionFactory,
        interpreterService: IInterpreterService,
        processServiceFactory: IProcessServiceFactory,
        knownSearchPaths: IKnownSearchPathsForInterpreters,
        logger: ILogger,
        disposableRegistry: IDisposableRegistry,
        asyncRegistry: IAsyncDisposableRegistry,
        fileSystem: IFileSystem,
        sessionManager: IJupyterSessionManager,
        workspace: IWorkspaceService,
        configuration: IConfigurationService,
        commandFactory : IJupyterCommandFactory,
        serviceContainer: IServiceContainer) {
        super(
            liveShare,
            executionFactory,
            interpreterService,
            processServiceFactory,
            knownSearchPaths,
            logger,
            disposableRegistry,
            asyncRegistry,
            fileSystem,
            new GuestJupyterSessionManager(sessionManager), // Don't talk to the active session on the guest side.
            workspace,
            configuration,
            commandFactory,
            serviceContainer);
        asyncRegistry.push(this);
        this.serverCache = new ServerCache(configuration, workspace, fileSystem);
    }

    public async dispose() : Promise<void> {
        await super.dispose();

        // Dispose of all of our cached servers
        await this.serverCache.dispose();
    }

    public async connectToNotebookServer(version: IJupyterVersion, options?: INotebookServerOptions, cancelToken?: CancellationToken): Promise<INotebookServer> {
        let result: INotebookServer | undefined = await this.serverCache.get(options);

        // See if we already have this server or not.
        if (result) {
            return result;
        }

        // Create the server on the remote machine. It should return an IConnection we can use to build a remote uri
        const service = await this.waitForService();
        if (service) {
            const purpose = options ? options.purpose : uuid();
            const connection: IConnection = await service.request(
                LiveShareCommands.connectToNotebookServer,
                [version, options],
                cancelToken);

            // If that works, then treat this as a remote server and connect to it
            if (connection && connection.baseUrl) {
                const newUri = `${connection.baseUrl}?token=${connection.token}`;
                result = await super.connectToNotebookServer(
                    version,
                    {
                        resource: options && options.resource,
                        uri: newUri,
                        useDefaultConfig: options && options.useDefaultConfig,
                        workingDir: options ? options.workingDir : undefined,
                        purpose
                    },
                    cancelToken);
                // Save in our cache
                if (result) {
                    await this.serverCache.set(result, noop, options);
                }
            }
        }

        if (!result) {
            throw new JupyterConnectError(localize.DataScience.liveShareConnectFailure());
        }

        return result;
    }

    public async enumerateVersions(serverURI?: string) : Promise<IJupyterVersion[]> {
        const service = await this.waitForService();
        if (service) {
            return service.request(
                LiveShareCommands.enumerateVersions,
                [serverURI]);
        }

        return [];
    }

    public spawnNotebook(_version: IJupyterVersion, _file: string): Promise<void> {
        // Not supported in liveshare
        throw new Error(localize.DataScience.liveShareCannotSpawnNotebooks());
    }

    public async getServer(options?: INotebookServerOptions) : Promise<INotebookServer | undefined> {
        return this.serverCache.get(options);
    }
}
