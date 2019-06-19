// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';
import { inject, injectable } from 'inversify';
import * as path from 'path';
import { CancellationToken, Uri } from 'vscode';

import { Cancellation } from '../../../client/common/cancellation';
import { IWorkspaceService } from '../../common/application/types';
import { traceInfo, traceWarning } from '../../common/logger';
import { IFileSystem } from '../../common/platform/types';
import {
    ExecutionResult,
    IProcessService,
    IProcessServiceFactory,
    IPythonExecutionFactory,
    IPythonExecutionService,
    ObservableExecutionResult,
    SpawnOptions
} from '../../common/process/types';
import { IConfigurationService, IDisposable, IDisposableRegistry } from '../../common/types';
import { IEnvironmentActivationService } from '../../interpreter/activation/types';
import { IInterpreterService, IKnownSearchPathsForInterpreters, PythonInterpreter } from '../../interpreter/contracts';
import { JupyterCommands, RegExpValues } from '../constants';
import { IJupyterCommand, IJupyterCommandFactory } from '../types';

// JupyterCommand objects represent some process that can be launched that should be guaranteed to work because it
// was found by testing it previously
class ProcessJupyterCommand implements IJupyterCommand {
    private exe: string;
    private requiredArgs: string[];
    private launcherPromise: Promise<IProcessService>;
    private interpreterPromise: Promise<PythonInterpreter | undefined>;
    private activationHelper: IEnvironmentActivationService;

    constructor(resource: Uri | undefined, exe: string, args: string[], processServiceFactory: IProcessServiceFactory, activationHelper: IEnvironmentActivationService, interpreterService: IInterpreterService) {
        this.exe = exe;
        this.requiredArgs = args;
        this.launcherPromise = processServiceFactory.create(resource);
        this.activationHelper = activationHelper;
        this.interpreterPromise = interpreterService.getInterpreterDetails(this.exe).catch(_e => undefined);
    }

    public interpreter() : Promise<PythonInterpreter | undefined> {
        return this.interpreterPromise;
    }

    public async execObservable(args: string[], options: SpawnOptions): Promise<ObservableExecutionResult<string>> {
        const newOptions = { ...options };
        newOptions.env = await this.fixupEnv(newOptions.env);
        const launcher = await this.launcherPromise;
        const newArgs = [...this.requiredArgs, ...args];
        return launcher.execObservable(this.exe, newArgs, newOptions);
    }

    public async exec(args: string[], options: SpawnOptions): Promise<ExecutionResult<string>> {
        const newOptions = { ...options };
        newOptions.env = await this.fixupEnv(newOptions.env);
        const launcher = await this.launcherPromise;
        const newArgs = [...this.requiredArgs, ...args];
        return launcher.exec(this.exe, newArgs, newOptions);
    }

    private fixupEnv(_env: NodeJS.ProcessEnv) : Promise<NodeJS.ProcessEnv | undefined> {
        if (this.activationHelper) {
            return this.activationHelper.getActivatedEnvironmentVariables(undefined);
        }

        return Promise.resolve(process.env);
    }

}

class InterpreterJupyterCommand implements IJupyterCommand {
    private requiredArgs: string[];
    private interpreterPromise: Promise<PythonInterpreter | undefined>;
    private pythonLauncher: Promise<IPythonExecutionService>;

    constructor(args: string[], pythonExecutionFactory: IPythonExecutionFactory, interpreter: PythonInterpreter) {
        this.requiredArgs = args;
        this.interpreterPromise = Promise.resolve(interpreter);
        this.pythonLauncher = pythonExecutionFactory.createActivatedEnvironment({ resource: undefined, interpreter, allowEnvironmentFetchExceptions: true });
    }

    public interpreter() : Promise<PythonInterpreter | undefined> {
        return this.interpreterPromise;
    }

    public async execObservable(args: string[], options: SpawnOptions): Promise<ObservableExecutionResult<string>> {
        const newOptions = { ...options };
        const launcher = await this.pythonLauncher;
        const newArgs = [...this.requiredArgs, ...args];
        return launcher.execObservable(newArgs, newOptions);
    }

    public async exec(args: string[], options: SpawnOptions): Promise<ExecutionResult<string>> {
        const newOptions = { ...options };
        const launcher = await this.pythonLauncher;
        const newArgs = [...this.requiredArgs, ...args];
        return launcher.exec(newArgs, newOptions);
    }
}

enum ModuleExistsResult {
    NotFound,
    FoundJupyter,
    Found
}

@injectable()
export class JupyterCommandFactory implements IJupyterCommandFactory, IDisposable {

    private uriCommands: Map<string, IJupyterCommand> = new Map<string, IJupyterCommand>();
    private interpreterCommands: Map<string, IJupyterCommand | undefined> = new Map<string, IJupyterCommand | undefined>();
    private jupyterPath: string | undefined;

    constructor(
        @inject(IPythonExecutionFactory) private executionFactory: IPythonExecutionFactory,
        @inject(IEnvironmentActivationService) private activationHelper : IEnvironmentActivationService,
        @inject(IProcessServiceFactory) private processServiceFactory: IProcessServiceFactory,
        @inject(IInterpreterService) private interpreterService: IInterpreterService,
        @inject(IWorkspaceService) workspace: IWorkspaceService,
        @inject(IDisposableRegistry) private disposableRegistry: IDisposableRegistry,
        @inject(IConfigurationService) private configuration: IConfigurationService,
        @inject(IKnownSearchPathsForInterpreters) private knownSearchPaths: IKnownSearchPathsForInterpreters,
        @inject(IFileSystem) private fileSystem: IFileSystem

    ) {
        this.disposableRegistry.push(this.interpreterService.onDidChangeInterpreter(() => this.onSettingsChanged()));
        this.disposableRegistry.push(this);

        if (workspace) {
            const disposable = workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('python.dataScience', undefined)) {
                    // When config changes happen, recreate our commands.
                    this.onSettingsChanged();
                }
            });
            this.disposableRegistry.push(disposable);
        }
    }

    public dispose() : void {
        this.onSettingsChanged();
    }

    // For jupyter,
    // - Look in current interpreter, if found create something that has path and args
    // - Look in other interpreters, if found create something that has path and args
    // - Look on path, if found create something that has path and args
    // For general case
    // - Look for module in current interpreter, if found create something with python path and -m module
    // - Look in other interpreters, if found create something with python path and -m module
    // - Look on path for jupyter, if found create something with jupyter path and args
    // tslint:disable:cyclomatic-complexity
    public async getBestCommand(resource: Uri | undefined, command: string, cancelToken?: CancellationToken): Promise<IJupyterCommand | undefined> {
        // See if we already have this command in list
        if (!this.uriCommands.has(command)) {
            // Not found, try to find it.

            // First we look in the current interpreter
            const current = await this.interpreterService.getActiveInterpreter(resource);
            let found = current ? await this.getExactCommand(current, command, cancelToken) : undefined;
            if (!found) {
                traceInfo(`Active interpreter does not support ${command}. Interpreter is ${current ? current.displayName : 'undefined'}.`);
            }
            if (!found && this.supportsSearchingForCommands()) {
                // Look through all of our interpreters (minus the active one at the same time)
                const all = await this.interpreterService.getInterpreters();

                if (!all || all.length === 0) {
                    traceWarning('No interpreters found. Jupyter cannot run.');
                }

                const promises = all.filter(i => i !== current).map(i => this.getExactCommand(i, command, cancelToken));
                const foundList = await Promise.all(promises);

                // Then go through all of the found ones and pick the closest python match
                if (current && current.version) {
                    let bestScore = -1;
                    for (const entry of foundList) {
                        let currentScore = 0;
                        if (!entry) {
                            continue;
                        }
                        const interpreter = await entry.interpreter();
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
                        if (currentScore > bestScore) {
                            found = entry;
                            bestScore = currentScore;
                        }
                    }
                } else {
                    // Just pick the first one
                    found = foundList.find(f => f !== undefined);
                }
            }

            // If still not found, try looking on the path using jupyter
            if (!found && this.supportsSearchingForCommands()) {
                found = await this.findPathCommand(resource, command, cancelToken);
            }

            // If we found a command, save in our dictionary
            if (found) {
                this.uriCommands.set(command, found);
            }
        }

        // Return results
        return this.uriCommands.get(command);
    }

    public async getExactCommand(interpreter: PythonInterpreter, command: string, cancelToken?: CancellationToken): Promise<IJupyterCommand | undefined> {
        // May be cached already
        const key = this.generateInterpreterCommandKey(interpreter, command);
        if (!this.interpreterCommands.has(key)) {
            let result: IJupyterCommand | undefined;
            // If the module is found on this interpreter, then we found it.
            if (interpreter && !Cancellation.isCanceled(cancelToken)) {
                const exists = await this.doesModuleExist(command, interpreter, cancelToken);

                if (exists === ModuleExistsResult.FoundJupyter) {
                    result = this.createInterpreterCommand(['-m', 'jupyter', command], interpreter);
                } else if (exists === ModuleExistsResult.Found) {
                    result = this.createInterpreterCommand(['-m', command], interpreter);
                }
            }
            this.interpreterCommands.set(key, result);
        }
        return this.interpreterCommands.get(key);
    }

    private generateInterpreterCommandKey(interpreter: PythonInterpreter, command: string) : string {
        return `${command}:${interpreter.path}:${interpreter.displayName ? interpreter.displayName : interpreter.envName}`;
    }

    private supportsSearchingForCommands(): boolean {
        if (this.configuration) {
            const settings = this.configuration.getSettings();
            if (settings) {
                return settings.datascience.searchForJupyter;
            }
        }
        return true;
    }

    private onSettingsChanged() {
        this.uriCommands.clear();
        this.interpreterCommands.clear();
    }

    private lookForJupyterInDirectory = async (pathToCheck: string): Promise<string[]> => {
        try {
            const files = await this.fileSystem.getFiles(pathToCheck);
            return files ? files.filter(s => RegExpValues.CheckJupyterRegEx.test(path.basename(s))) : [];
        } catch (err) {
            traceWarning('Python Extension (fileSystem.getFiles):', err);
        }
        return [] as string[];
    }

    private searchPathsForJupyter = async (): Promise<string | undefined> => {
        if (!this.jupyterPath) {
            const paths = this.knownSearchPaths.getSearchPaths();
            for (let i = 0; i < paths.length && !this.jupyterPath; i += 1) {
                const found = await this.lookForJupyterInDirectory(paths[i]);
                if (found.length > 0) {
                    this.jupyterPath = found[0];
                }
            }
        }
        return this.jupyterPath;
    }

    private findPathCommand = async (resource: Uri | undefined, command: string, cancelToken?: CancellationToken): Promise<IJupyterCommand | undefined> => {
        if (await this.doesJupyterCommandExist(resource, command, cancelToken) && !Cancellation.isCanceled(cancelToken)) {
            // Search the known paths for jupyter
            const jupyterPath = await this.searchPathsForJupyter();
            if (jupyterPath) {
                return this.createProcessCommand(resource, jupyterPath, [command]);
            }
        }
        return undefined;
    }

    private getProcessService(resource: Uri | undefined) : Promise<IProcessService> {
        return this.processServiceFactory.create(resource);
    }

    private async doesJupyterCommandExist(resource: Uri | undefined, command?: string, cancelToken?: CancellationToken): Promise<boolean> {
        const newOptions: SpawnOptions = { throwOnStdErr: true, encoding: 'utf8', token: cancelToken };
        const args = command ? [command, '--version'] : ['--version'];
        const processService = await this.getProcessService(resource);
        try {
            const result = await processService.exec('jupyter', args, newOptions);
            return !result.stderr;
        } catch (err) {
            traceWarning(err);
            return false;
        }
    }

    private async doesModuleExist(moduleName: string, interpreter: PythonInterpreter, cancelToken?: CancellationToken): Promise<ModuleExistsResult> {
        if (interpreter && interpreter !== null) {
            const newOptions: SpawnOptions = { throwOnStdErr: true, encoding: 'utf8', token: cancelToken };
            const pythonService = await this.executionFactory.createActivatedEnvironment({ resource: undefined, interpreter, allowEnvironmentFetchExceptions: true });

            // For commands not 'ipykernel' first try them as jupyter commands
            if (moduleName !== JupyterCommands.KernelCreateCommand) {
                try {
                    const result = await pythonService.execModule('jupyter', [moduleName, '--version'], newOptions);
                    if (!result.stderr) {
                        return ModuleExistsResult.FoundJupyter;
                    } else {
                        traceWarning(`${result.stderr} for ${interpreter.path}`);
                    }
                } catch (err) {
                    traceWarning(`${err} for ${interpreter.path}`);
                }
            }

            // After trying first as "-m jupyter <module> --version" then try "-m <module> --version" as this works in some cases
            // for example if not running in an activated environment without script on the path
            try {
                const result = await pythonService.execModule(moduleName, ['--version'], newOptions);
                if (!result.stderr) {
                    return ModuleExistsResult.Found;
                } else {
                    traceWarning(`${result.stderr} for ${interpreter.path}`);
                    return ModuleExistsResult.NotFound;
                }
            } catch (err) {
                traceWarning(`${err} for ${interpreter.path}`);
                return ModuleExistsResult.NotFound;
            }
        } else {
            traceWarning(`Interpreter not found. ${moduleName} cannot be loaded.`);
            return ModuleExistsResult.NotFound;
        }
    }

    private createInterpreterCommand(args: string[], interpreter: PythonInterpreter): IJupyterCommand {
        return new InterpreterJupyterCommand(args, this.executionFactory, interpreter);
    }

    private createProcessCommand(resource: Uri | undefined, exe: string, args: string[]): IJupyterCommand {
        return new ProcessJupyterCommand(resource, exe, args, this.processServiceFactory, this.activationHelper, this.interpreterService);
    }
}
