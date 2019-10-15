// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';
import * as assert from 'assert';
import { mount, ReactWrapper } from 'enzyme';
import * as React from 'react';
import * as TypeMoq from 'typemoq';
import { Disposable, Uri } from 'vscode';
import * as vsls from 'vsls/vscode';

import {
    IApplicationShell,
    ICommandManager,
    IDocumentManager,
    ILiveShareApi,
    ILiveShareTestingApi
} from '../../client/common/application/types';
import { IFileSystem } from '../../client/common/platform/types';
import { Commands } from '../../client/datascience/constants';
import {
    ICodeWatcher,
    IDataScienceCommandListener,
    IInteractiveWindow,
    IInteractiveWindowProvider,
    IJupyterExecution,
    INotebookEditor,
    INotebookEditorProvider
} from '../../client/datascience/types';
import { InteractivePanel } from '../../datascience-ui/history-react/interactivePanel';
import { NativeEditor } from '../../datascience-ui/native-editor/nativeEditor';
import { asyncDump } from '../common/asyncDump';
import { DataScienceIocContainer } from './dataScienceIocContainer';
import { createDocument } from './editor-integration/helpers';
import { waitForUpdate } from './reactHelpers';
import { addMockData, CellPosition, verifyHtmlOnCell } from './testHelpers';
//tslint:disable:trailing-comma no-any no-multiline-string

// tslint:disable-next-line:max-func-body-length no-any
suite('DataScience LiveShare tests', () => {
    const disposables: Disposable[] = [];
    let InteractiveHostContainer: DataScienceIocContainer;
    let InteractiveGuestContainer: DataScienceIocContainer;
    let NotebookHostContainer: DataScienceIocContainer;
    let NotebookGuestContainer: DataScienceIocContainer;
    let lastErrorMessage : string | undefined;

    setup(() => {
        InteractiveHostContainer = createContainer(vsls.Role.Host, false);
        InteractiveGuestContainer = createContainer(vsls.Role.Guest, false);
        NotebookHostContainer = createContainer(vsls.Role.Host, true);
        NotebookGuestContainer = createContainer(vsls.Role.Guest, true);
    });

    teardown(async () => {
        for (const disposable of disposables) {
            if (!disposable) {
                continue;
            }
            // tslint:disable-next-line:no-any
            const promise = disposable.dispose() as Promise<any>;
            if (promise) {
                await promise;
            }
        }
        await InteractiveHostContainer.dispose();
        await InteractiveGuestContainer.dispose();
        await NotebookHostContainer.dispose();
        await NotebookGuestContainer.dispose();
        lastErrorMessage = undefined;
    });

    suiteTeardown(() => {
        asyncDump();
    });

    function createContainer(role: vsls.Role, isNotebook: boolean): DataScienceIocContainer {
        const result = new DataScienceIocContainer();
        result.registerDataScienceTypes();

        // Rebind the appshell so we can change what happens on an error
        const dummyDisposable = {
            dispose: () => { return; }
        };
        const appShell = TypeMoq.Mock.ofType<IApplicationShell>();
        appShell.setup(a => a.showErrorMessage(TypeMoq.It.isAnyString())).returns((e) => lastErrorMessage = e);
        appShell.setup(a => a.showInformationMessage(TypeMoq.It.isAny(), TypeMoq.It.isAny())).returns(() => Promise.resolve(''));
        appShell.setup(a => a.showInformationMessage(TypeMoq.It.isAny(), TypeMoq.It.isAny(), TypeMoq.It.isAny())).returns((_a1: string, a2: string, _a3: string) => Promise.resolve(a2));
        appShell.setup(a => a.showSaveDialog(TypeMoq.It.isAny())).returns(() => Promise.resolve(Uri.file('test.ipynb')));
        appShell.setup(a => a.setStatusBarMessage(TypeMoq.It.isAny())).returns(() => dummyDisposable);

        result.serviceManager.rebindInstance<IApplicationShell>(IApplicationShell, appShell.object);

        // Setup our webview panel
        if (isNotebook) {
            result.createWebView(() => mount(<NativeEditor baseTheme='vscode-light' codeTheme='light_vs' testMode={true} skipDefault={true} />), role);
        } else {
            result.createWebView(() => mount(<InteractivePanel baseTheme='vscode-light' codeTheme='light_vs' testMode={true} skipDefault={true} />), role);
        }

        // Make sure the history provider and execution factory in the container is created (the extension does this on startup in the extension)
        // This is necessary to get the appropriate live share services up and running.
        result.get<INotebookEditorProvider>(INotebookEditorProvider);
        result.get<IInteractiveWindowProvider>(IInteractiveWindowProvider);
        result.get<IJupyterExecution>(IJupyterExecution);
        return result;
    }

    function getOrCreateWindow(role: vsls.Role, isNotebook: boolean): Promise<INotebookEditor | IInteractiveWindow> {
        // Get the container to use based on the role.
        if (isNotebook) {
            const container = role === vsls.Role.Host ? NotebookHostContainer : NotebookGuestContainer;
            return container!.get<INotebookEditorProvider>(INotebookEditorProvider).createNew();
        } else {
            const container = role === vsls.Role.Host ? InteractiveHostContainer : InteractiveGuestContainer;
            return container!.get<IInteractiveWindowProvider>(IInteractiveWindowProvider).getOrCreateActive();
        }
    }

    function isSessionStarted(role: vsls.Role, isNotebook: boolean): boolean {
        let container: DataScienceIocContainer;

        if (isNotebook) {
            container = role === vsls.Role.Host ? NotebookHostContainer : NotebookGuestContainer;
        } else {
            container = role === vsls.Role.Host ? InteractiveHostContainer : InteractiveGuestContainer;
        }

        const api = container!.get<ILiveShareApi>(ILiveShareApi) as ILiveShareTestingApi;
        return api.isSessionStarted;
    }

    async function waitForResults(role: vsls.Role, resultGenerator: (both: boolean) => Promise<void>, isNotebook: boolean,
        expectedRenderCount: number = 5): Promise<ReactWrapper<any, Readonly<{}>, React.Component>> {
        let container: DataScienceIocContainer;

        if (isNotebook) {
            container = role === vsls.Role.Host ? NotebookHostContainer : NotebookGuestContainer;
        } else {
            container = role === vsls.Role.Host ? InteractiveHostContainer : InteractiveGuestContainer;
        }

        const component = isNotebook ? NativeEditor : InteractivePanel;

        // If just the host session has started or nobody, just run the host.
        const guestStarted = isSessionStarted(vsls.Role.Guest, isNotebook);
        if (!guestStarted) {
            const hostRenderPromise = waitForUpdate(isNotebook ? NotebookHostContainer.wrapper! : InteractiveHostContainer.wrapper!, component, expectedRenderCount);

            // Generate our results
            await resultGenerator(false);

            // Wait for all of the renders to go through
            await hostRenderPromise;
        } else {
            // Otherwise more complicated. We have to wait for renders on both

            // Get a render promise with the expected number of renders for both wrappers
            const hostRenderPromise = waitForUpdate(isNotebook ? NotebookHostContainer.wrapper! : InteractiveHostContainer.wrapper!, component, expectedRenderCount);
            const guestRenderPromise = waitForUpdate(isNotebook ? NotebookGuestContainer.wrapper! : InteractiveGuestContainer.wrapper!, component, expectedRenderCount);

            // Generate our results
            await resultGenerator(true);

            // Wait for all of the renders to go through. Guest may have been shutdown by now.
            await Promise.all([hostRenderPromise, isSessionStarted(vsls.Role.Guest, isNotebook) ? guestRenderPromise : Promise.resolve()]);
        }
        return container.wrapper!;
    }

    async function addCodeToRole(role: vsls.Role, code: string, isNotebook: boolean, expectedRenderCount: number = 5): Promise<ReactWrapper<any, Readonly<{}>, React.Component>> {
        return waitForResults(role, async (both: boolean) => {
            if (!both) {
                const window = await getOrCreateWindow(role, isNotebook);
                await window.addCode(code, Uri.file('foo.py').fsPath, 2);
            } else {
                // Add code to the apropriate container
                const host = await getOrCreateWindow(vsls.Role.Host, isNotebook);

                // Make sure guest is still creatable
                if (isSessionStarted(vsls.Role.Guest, isNotebook)) {
                    const guest = await getOrCreateWindow(vsls.Role.Guest, isNotebook);
                    (role === vsls.Role.Host ? await host.addCode(code, Uri.file('foo.py').fsPath, 2) : await guest.addCode(code, Uri.file('foo.py').fsPath, 2));
                } else {
                    await host.addCode(code, Uri.file('foo.py').fsPath, 2);
                }
            }
        }, isNotebook, expectedRenderCount);
    }

    function startSession(role: vsls.Role, isNotebook: boolean): Promise<void> {
        let container: DataScienceIocContainer;

        if (isNotebook) {
            container = role === vsls.Role.Host ? NotebookHostContainer : NotebookGuestContainer;
        } else {
            container = role === vsls.Role.Host ? InteractiveHostContainer : InteractiveGuestContainer;
        }

        const api = container!.get<ILiveShareApi>(ILiveShareApi) as ILiveShareTestingApi;
        return api.startSession();
    }

    function stopSession(role: vsls.Role, isNotebook: boolean): Promise<void> {
        let container: DataScienceIocContainer;

        if (isNotebook) {
            container = role === vsls.Role.Host ? NotebookHostContainer : NotebookGuestContainer;
        } else {
            container = role === vsls.Role.Host ? InteractiveHostContainer : InteractiveGuestContainer;
        }

        const api = container!.get<ILiveShareApi>(ILiveShareApi) as ILiveShareTestingApi;
        return api.stopSession();
    }

    function disableGuestChecker(role: vsls.Role, isNotebook: boolean) {
        let container: DataScienceIocContainer;

        if (isNotebook) {
            container = role === vsls.Role.Host ? NotebookHostContainer : NotebookGuestContainer;
        } else {
            container = role === vsls.Role.Host ? InteractiveHostContainer : InteractiveGuestContainer;
        }

        const api = container!.get<ILiveShareApi>(ILiveShareApi) as ILiveShareTestingApi;
        api.disableGuestChecker();
    }

    function getContainer(role: vsls.Role, isNotebook: boolean): DataScienceIocContainer {
        let container: DataScienceIocContainer;

        if (isNotebook) {
            container = role === vsls.Role.Host ? NotebookHostContainer : NotebookGuestContainer;
        } else {
            container = role === vsls.Role.Host ? InteractiveHostContainer : InteractiveGuestContainer;
        }

        return container;
    }

    function runDoubleLiveshareTest(name: string, testFunc: (isNotebook: boolean) => Promise<void>) {
        test(`${name} (interactive)`, async () => testFunc(false));
        test(`${name} (notebook)`, async () => testFunc(true));
    }

    runDoubleLiveshareTest('Liveshare - Host alone', hostAloneTest);

    async function hostAloneTest(isNotebook: boolean) {
        const host = getContainer(vsls.Role.Host, isNotebook);
        // Should only need mock data in host
        addMockData(host!, 'a=1\na', 1);

        // Start the host session first
        await startSession(vsls.Role.Host, isNotebook);

        // Just run some code in the host
        const wrapper = await addCodeToRole(vsls.Role.Host, 'a=1\na', isNotebook);
        verifyHtmlOnCell(wrapper, isNotebook ? 'NativeCell' : 'InteractiveCell', '<span>1</span>', CellPosition.Last);
    }

    runDoubleLiveshareTest('Liveshare - Host & Guest Simple', hostAndGuestSimpleTest);

    async function hostAndGuestSimpleTest(isNotebook: boolean) {
        const host = getContainer(vsls.Role.Host, isNotebook);
        const guest = getContainer(vsls.Role.Guest, isNotebook);

        // Should only need mock data in host
        addMockData(host!, 'a=1\na', 1);

        // Create the host history and then the guest history
        await getOrCreateWindow(vsls.Role.Host, isNotebook);
        await startSession(vsls.Role.Host, isNotebook);
        await getOrCreateWindow(vsls.Role.Guest, isNotebook);
        await startSession(vsls.Role.Guest, isNotebook);

        // Send code through the host
        const wrapper = await addCodeToRole(vsls.Role.Host, 'a=1\na', isNotebook);
        verifyHtmlOnCell(wrapper, isNotebook ? 'NativeCell' : 'InteractiveCell', '<span>1</span>', CellPosition.Last);

        // Verify it ended up on the guest too
        assert.ok(guest.wrapper, 'Guest wrapper not created');
        verifyHtmlOnCell(guest.wrapper!, isNotebook ? 'NativeCell' : 'InteractiveCell', '<span>1</span>', CellPosition.Last);
    }

    runDoubleLiveshareTest('Liveshare - Host starts LiveShare after starting Jupyter', hostStartsLiveshareAfterStartingJupyterTest);

    async function hostStartsLiveshareAfterStartingJupyterTest(isNotebook: boolean) {
        const host = getContainer(vsls.Role.Host, isNotebook);
        const guest = getContainer(vsls.Role.Guest, isNotebook);

        addMockData(host!, 'a=1\na', 1);
        addMockData(host!, 'b=2\nb', 2);
        await getOrCreateWindow(vsls.Role.Host, isNotebook);
        let wrapper = await addCodeToRole(vsls.Role.Host, 'a=1\na', isNotebook);
        verifyHtmlOnCell(wrapper, isNotebook ? 'NativeCell' : 'InteractiveCell', '<span>1</span>', CellPosition.Last);

        await startSession(vsls.Role.Host, isNotebook);
        await getOrCreateWindow(vsls.Role.Guest, isNotebook);
        await startSession(vsls.Role.Guest, isNotebook);

        wrapper = await addCodeToRole(vsls.Role.Host, 'b=2\nb', isNotebook);

        assert.ok(guest.wrapper, 'Guest wrapper not created');
        verifyHtmlOnCell(guest.wrapper!, isNotebook ? 'NativeCell' : 'InteractiveCell', '<span>2</span>', CellPosition.Last);
    }

    runDoubleLiveshareTest('Liveshare - Host Shutdown and Run', hostShutdownAndRunTest);

    async function hostShutdownAndRunTest(isNotebook: boolean) {
        const host = getContainer(vsls.Role.Host, isNotebook);

        // Should only need mock data in host
        addMockData(host!, 'a=1\na', 1);

        // Create the host history and then the guest history
        await getOrCreateWindow(vsls.Role.Host, isNotebook);
        await startSession(vsls.Role.Host, isNotebook);

        // Send code through the host
        let wrapper = await addCodeToRole(vsls.Role.Host, 'a=1\na', isNotebook);
        verifyHtmlOnCell(wrapper, isNotebook ? 'NativeCell' : 'InteractiveCell', '<span>1</span>', CellPosition.Last);

        // Stop the session
        await stopSession(vsls.Role.Host, isNotebook);

        // Send code again. It should still work.
        wrapper = await addCodeToRole(vsls.Role.Host, 'a=1\na', isNotebook);
        verifyHtmlOnCell(wrapper, isNotebook ? 'NativeCell' : 'InteractiveCell', '<span>1</span>', CellPosition.Last);
    }

    runDoubleLiveshareTest('Liveshare - Host startup and guest restart', hostStartupAndGuestRestartTest);

    async function hostStartupAndGuestRestartTest(isNotebook: boolean) {
        const hostContainer = getContainer(vsls.Role.Host, isNotebook);

        // Should only need mock data in host
        addMockData(hostContainer!, 'a=1\na', 1);

        // Start the host, and add some data
        const host = await getOrCreateWindow(vsls.Role.Host, isNotebook);
        await startSession(vsls.Role.Host, isNotebook);

        // Send code through the host
        let wrapper = await addCodeToRole(vsls.Role.Host, 'a=1\na', isNotebook);
        verifyHtmlOnCell(wrapper, isNotebook ? 'NativeCell' : 'InteractiveCell', '<span>1</span>', CellPosition.Last);

        // Shutdown the host
        await host.dispose();

        // Startup a guest and run some code.
        await startSession(vsls.Role.Guest, isNotebook);
        wrapper = await addCodeToRole(vsls.Role.Guest, 'a=1\na', isNotebook);
        verifyHtmlOnCell(wrapper, isNotebook ? 'NativeCell' : 'InteractiveCell', '<span>1</span>', CellPosition.Last);

        assert.ok(hostContainer.wrapper, 'Host wrapper not created');
        verifyHtmlOnCell(hostContainer.wrapper!, isNotebook ? 'NativeCell' : 'InteractiveCell', '<span>1</span>', CellPosition.Last);
    }

    runDoubleLiveshareTest('Liveshare - Going through codewatcher', goingThroughCodewatcherTest);

    async function goingThroughCodewatcherTest(isNotebook: boolean) {
        const host = getContainer(vsls.Role.Host, isNotebook);
        const guest = getContainer(vsls.Role.Guest, isNotebook);

        // Should only need mock data in host
        addMockData(host!, '#%%\na=1\na', 1);

        // Start both the host and the guest
        await startSession(vsls.Role.Host, isNotebook);
        await startSession(vsls.Role.Guest, isNotebook);

        // Setup a document and text
        const fileName = 'test.py';
        const version = 1;
        const inputText = '#%%\na=1\na';
        const document = createDocument(inputText, fileName, version, TypeMoq.Times.atLeastOnce());
        document.setup(doc => doc.getText(TypeMoq.It.isAny())).returns(() => inputText);

        const codeWatcher = guest!.get<ICodeWatcher>(ICodeWatcher);
        codeWatcher.setDocument(document.object);

        // Send code using a codewatcher instead (we're sending it through the guest)
        const wrapper = await waitForResults(vsls.Role.Guest, async (both: boolean) => {
            // Should always be both
            assert.ok(both, 'Expected both guest and host to be used');
            await codeWatcher.runAllCells();
        }, isNotebook);
        verifyHtmlOnCell(wrapper, isNotebook ? 'NativeCell' : 'InteractiveCell', '<span>1</span>', CellPosition.Last);
        assert.ok(host.wrapper, 'Host wrapper not created for some reason');
        verifyHtmlOnCell(host.wrapper!, isNotebook ? 'NativeCell' : 'InteractiveCell', '<span>1</span>', CellPosition.Last);
    }

    runDoubleLiveshareTest('Liveshare - Export from guest', exportFromGuestTest);

    async function exportFromGuestTest(isNotebook: boolean) {
        const host = getContainer(vsls.Role.Host, isNotebook);
        const guest = getContainer(vsls.Role.Guest, isNotebook);

        // Should only need mock data in host
        addMockData(host!, '#%%\na=1\na', 1);

        // Remap the fileSystem so we control the write for the notebook. Have to do this
        // before the listener is created so that it uses this file system.
        let outputContents: string | undefined;
        const fileSystem = TypeMoq.Mock.ofType<IFileSystem>();
        guest!.serviceManager.rebindInstance<IFileSystem>(IFileSystem, fileSystem.object);
        fileSystem.setup(f => f.writeFile(TypeMoq.It.isAny(), TypeMoq.It.isAny())).returns((_f, c) => {
            outputContents = c.toString();
            return Promise.resolve();
        });
        fileSystem.setup(f => f.arePathsSame(TypeMoq.It.isAny(), TypeMoq.It.isAny()))
            .returns(() => true);
        fileSystem.setup(f => f.getSubDirectories(TypeMoq.It.isAny())).returns(() => Promise.resolve([]));

        // Need to register commands as our extension isn't actually loading.
        const listeners = guest!.getAll<IDataScienceCommandListener>(IDataScienceCommandListener);
        const guestCommandManager = guest!.get<ICommandManager>(ICommandManager);
        listeners.forEach(f => f.register(guestCommandManager));

        // Start both the host and the guest
        await startSession(vsls.Role.Host, isNotebook);
        await startSession(vsls.Role.Guest, isNotebook);

        // Create a document on the guest
        guest!.addDocument('#%%\na=1\na', Uri.file('foo.py').fsPath);
        guest!.get<IDocumentManager>(IDocumentManager).showTextDocument(Uri.file('foo.py'));

        // Attempt to export a file from the guest by running an ExportFileAndOutputAsNotebook
        const executePromise = guestCommandManager.executeCommand(Commands.ExportFileAndOutputAsNotebook, Uri.file('foo.py')) as Promise<Uri>;
        assert.ok(executePromise, 'Export file did not return a promise');
        const savedUri = await executePromise;
        assert.ok(savedUri, 'Uri not returned from export');
        assert.equal(savedUri.fsPath, Uri.file('test.ipynb').fsPath, 'Export did not work');
        assert.ok(outputContents, 'Output not exported');
        assert.ok(outputContents!.includes('data'), 'Output is empty');
    }

    runDoubleLiveshareTest('Liveshare - Guest does not have extension', guestDoesNotHaveExtensionTest);

    async function guestDoesNotHaveExtensionTest(isNotebook: boolean) {
        const host = getContainer(vsls.Role.Host, isNotebook);

        // Should only need mock data in host
        addMockData(host!, '#%%\na=1\na', 1);

        // Start just the host and verify it works
        await startSession(vsls.Role.Host, isNotebook);
        let wrapper = await addCodeToRole(vsls.Role.Host, '#%%\na=1\na', isNotebook);
        verifyHtmlOnCell(wrapper, isNotebook ? 'NativeCell' : 'InteractiveCell', '<span>1</span>', CellPosition.Last);

        // Disable guest checking on the guest (same as if the guest doesn't have the python extension)
        await startSession(vsls.Role.Guest, isNotebook);
        disableGuestChecker(vsls.Role.Guest, isNotebook);

        // Host should now be in a state that if any code runs, the session should end. However
        // the code should still run
        wrapper = await addCodeToRole(vsls.Role.Host, '#%%\na=1\na', isNotebook);
        verifyHtmlOnCell(wrapper, isNotebook ? 'NativeCell' : 'InteractiveCell', '<span>1</span>', CellPosition.Last);
        assert.equal(isSessionStarted(vsls.Role.Host, isNotebook), false, 'Host should have exited session');
        assert.equal(isSessionStarted(vsls.Role.Guest, isNotebook), false, 'Guest should have exited session');
        assert.ok(lastErrorMessage, 'Error was not set during session shutdown');
    }
});
