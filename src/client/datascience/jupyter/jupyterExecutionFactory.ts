// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';
import { inject, injectable } from 'inversify';
import { CancellationToken, Event, EventEmitter, Uri } from 'vscode';

import { ILiveShareApi, IWorkspaceService } from '../../common/application/types';
import { IFileSystem } from '../../common/platform/types';
import { IProcessServiceFactory, IPythonExecutionFactory } from '../../common/process/types';
import {
    IAsyncDisposable,
    IAsyncDisposableRegistry,
    IConfigurationService,
    IDisposableRegistry,
    ILogger
} from '../../common/types';
import { IInterpreterService, IKnownSearchPathsForInterpreters, PythonInterpreter } from '../../interpreter/contracts';
import { IServiceContainer } from '../../ioc/types';
import {
    IJupyterCommandFactory,
    IJupyterExecution,
    IJupyterSessionManager,
    INotebookServer,
    INotebookServerOptions
} from '../types';
import { GuestJupyterExecution } from './liveshare/guestJupyterExecution';
import { HostJupyterExecution } from './liveshare/hostJupyterExecution';
import { IRoleBasedObject, RoleBasedFactory } from './liveshare/roleBasedFactory';

interface IJupyterExecutionInterface extends IRoleBasedObject, IJupyterExecution {

}

// tslint:disable:callable-types
type JupyterExecutionClassType = {
    new(liveShare: ILiveShareApi,
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
        serviceContainer: IServiceContainer
    ): IJupyterExecutionInterface;
};
// tslint:enable:callable-types

@injectable()
export class JupyterExecutionFactory implements IJupyterExecution, IAsyncDisposable {

    private executionFactory: RoleBasedFactory<IJupyterExecutionInterface, JupyterExecutionClassType>;
    private sessionChangedEventEmitter: EventEmitter<void> = new EventEmitter<void>();

    constructor(@inject(ILiveShareApi) liveShare: ILiveShareApi,
                @inject(IPythonExecutionFactory) pythonFactory: IPythonExecutionFactory,
                @inject(IInterpreterService) interpreterService: IInterpreterService,
                @inject(IProcessServiceFactory) processServiceFactory: IProcessServiceFactory,
                @inject(IKnownSearchPathsForInterpreters) knownSearchPaths: IKnownSearchPathsForInterpreters,
                @inject(ILogger) logger: ILogger,
                @inject(IDisposableRegistry) disposableRegistry: IDisposableRegistry,
                @inject(IAsyncDisposableRegistry) asyncRegistry: IAsyncDisposableRegistry,
                @inject(IFileSystem) fileSystem: IFileSystem,
                @inject(IJupyterSessionManager) sessionManager: IJupyterSessionManager,
                @inject(IWorkspaceService) workspace: IWorkspaceService,
                @inject(IConfigurationService) configuration: IConfigurationService,
                @inject(IJupyterCommandFactory) commandFactory : IJupyterCommandFactory,
                @inject(IServiceContainer) serviceContainer: IServiceContainer) {
        asyncRegistry.push(this);
        this.executionFactory = new RoleBasedFactory<IJupyterExecutionInterface, JupyterExecutionClassType>(
            liveShare,
            HostJupyterExecution,
            GuestJupyterExecution,
            liveShare,
            pythonFactory,
            interpreterService,
            processServiceFactory,
            knownSearchPaths,
            logger,
            disposableRegistry,
            asyncRegistry,
            fileSystem,
            sessionManager,
            workspace,
            configuration,
            commandFactory,
            serviceContainer
        );
        this.executionFactory.sessionChanged(() => this.onSessionChanged());
    }

    public get sessionChanged() : Event<void> {
        return this.sessionChangedEventEmitter.event;
    }

    public async dispose() : Promise<void> {
        // Dispose of our execution object
        const execution = await this.executionFactory.get();
        return execution.dispose();
    }

    public async isNotebookSupported(resource: Uri | undefined, cancelToken?: CancellationToken): Promise<boolean> {
        const execution = await this.executionFactory.get();
        return execution.isNotebookSupported(resource, cancelToken);
    }
    public async isImportSupported(resource: Uri | undefined, cancelToken?: CancellationToken): Promise<boolean> {
        const execution = await this.executionFactory.get();
        return execution.isImportSupported(resource, cancelToken);
    }
    public async isKernelCreateSupported(resource: Uri | undefined, cancelToken?: CancellationToken): Promise<boolean> {
        const execution = await this.executionFactory.get();
        return execution.isKernelCreateSupported(resource, cancelToken);
    }
    public async isKernelSpecSupported(resource: Uri | undefined, cancelToken?: CancellationToken): Promise<boolean> {
        const execution = await this.executionFactory.get();
        return execution.isKernelSpecSupported(resource, cancelToken);
    }
    public async isSpawnSupported(resource: Uri | undefined, cancelToken?: CancellationToken): Promise<boolean> {
        const execution = await this.executionFactory.get();
        return execution.isSpawnSupported(resource, cancelToken);
    }
    public async connectToNotebookServer(options?: INotebookServerOptions, cancelToken?: CancellationToken): Promise<INotebookServer | undefined> {
        const execution = await this.executionFactory.get();
        return execution.connectToNotebookServer(options, cancelToken);
}
    public async spawnNotebook(file: string): Promise<void> {
        const execution = await this.executionFactory.get();
        return execution.spawnNotebook(file);
    }
    public async importNotebook(file: string, template: string | undefined): Promise<string> {
        const execution = await this.executionFactory.get();
        return execution.importNotebook(file, template);
    }
    public async getUsableJupyterPython(resource: Uri | undefined, cancelToken?: CancellationToken): Promise<PythonInterpreter | undefined> {
        const execution = await this.executionFactory.get();
        return execution.getUsableJupyterPython(resource, cancelToken);
    }
    public async getServer(options?: INotebookServerOptions) : Promise<INotebookServer | undefined> {
        const execution = await this.executionFactory.get();
        return execution.getServer(options);
    }

    private onSessionChanged() {
        this.sessionChangedEventEmitter.fire();
    }
}
