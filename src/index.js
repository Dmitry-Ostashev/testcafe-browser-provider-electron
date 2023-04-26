import path from 'path';
import { statSync } from 'fs';
import { spawn } from 'child_process';
import OS from 'os-family';
import debug from 'debug';
import lodash from 'lodash';
import { getFreePorts } from 'endpoint-utils';
import NodeInspect from './node-inspect';
import isAbsolute from './utils/is-absolute';
import getConfig from './utils/get-config';
import getHookCode from './hook';
import { Server as IPCServer } from './ipc';
import Helpers from './helpers';
import ERRORS from './errors';

import testRunTracker from 'testcafe/lib/api/test-run-tracker';
import { BrowserClient } from 'testcafe/lib/browser/provider/built-in/dedicated/chrome/cdp-client';
import ChromeRunTimeInfo from 'testcafe/lib/browser/provider/built-in/dedicated/chrome/runtime-info';
import NativeAutomation from 'testcafe/lib/native-automation';
import { dispatchEvent as dispatchNativeAutomationEvent, navigateTo } from 'testcafe/lib/native-automation/utils/cdp';
import { EventType } from 'testcafe/lib/native-automation/types';

const DEBUG_LOGGER = debug('testcafe:browser-provider-electron');
const STDOUT_LOGGER = DEBUG_LOGGER.extend('spawn:stdout');
const STDERR_LOGGER = DEBUG_LOGGER.extend('spawn:stderr');

function startElectron (config, ports) {
    var cmd            = '';
    var args           = null;
    var debugPortsArgs = [`--inspect-brk=${ports[1]}`, `--remote-debugging-port=${ports[2]}`];
    var extraArgs      = config.appArgs || [];

    if (OS.mac && statSync(config.electronPath).isDirectory()) {
        cmd  = 'open';
        args = ['-nW', '-a', config.electronPath, '--args'].concat(debugPortsArgs, extraArgs);
    }
    else {
        cmd  = config.electronPath;
        args = debugPortsArgs.concat(extraArgs);
    }

    var proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    proc.stdout.on('data', buf => STDOUT_LOGGER(lodash.trimEnd(String(buf), '\n')));
    proc.stderr.on('data', buf => STDERR_LOGGER(lodash.trimEnd(String(buf), '\n')));
}

async function injectHookCode (client, code) {
    await client.connect();
    await client.evaluate(code);

    client.dispose();
}


const ElectronBrowserProvider = {
    isMultiBrowser: true,
    openedBrowsers: {},
    runtimeInfo:    {},

    _getBrowserHelpers () {
        var testRun = testRunTracker.resolveContextTestRun();
        var id      = testRun.browserConnection.id;

        return ElectronBrowserProvider.openedBrowsers[id].helpers;
    },

    _createRunTimeInfo (hostName, config, disableMultipleWindows) {
        return ChromeRunTimeInfo.create(hostName, config, disableMultipleWindows);
    },

    async _setupNativeAutomation ({ browserId, browserClient, runtimeInfo, nativeAutomationOptions }) {
        const cdpClient = await browserClient.getActiveClient();
        const nativeAutomation = new NativeAutomation(browserId, cdpClient);

        await nativeAutomation.init(nativeAutomationOptions);

        runtimeInfo.nativeAutomation = nativeAutomation;
    },

    async _getActiveCDPClient (browserId) {
        const { browserClient } = this.openedBrowsers[browserId];
        const cdpClient         = await browserClient.getActiveClient();

        return cdpClient;
    },

    async _delay (ms) {
        return new Promise(
            resolve => setTimeout(resolve, ms)
        );
    },
    
    async isLocalBrowser () {
        return true;
    },

    async openBrowser (id, pageUrl, mainPath, { nativeAutomation }) {
        if (!isAbsolute(mainPath))
            mainPath = path.join(process.cwd(), mainPath);

        var config    = getConfig(id, mainPath);
        var ipcServer = new IPCServer(config);

        await ipcServer.start();

        var ports = await getFreePorts(3);

        const cdpPort = ports[2];

        startElectron(config, ports);

        var hookCode      = getHookCode(config, pageUrl);
        var inspectClient = new NodeInspect(ports[1]);

        await injectHookCode(inspectClient, hookCode);
        await ipcServer.connect();

        var injectingStatus = await ipcServer.getInjectingStatus();

        if (!injectingStatus.completed) {
            await ipcServer.terminateProcess();

            ipcServer.stop();

            throw new Error(ERRORS.render(ERRORS.mainUrlWasNotLoaded, {
                mainWindowUrl: config.mainWindowUrl,
                openedUrls:    injectingStatus.openedUrls
            }));
        }


        const runtimeInfo = { 
            config,
            cdpPort,

            browserId: id,
            ipc:       ipcServer,
            helpers:   new Helpers(ipcServer)
        };

        const browserClient = new BrowserClient(runtimeInfo);

        runtimeInfo.browserClient = browserClient;
        this.openedBrowsers[id]   = runtimeInfo;

        await browserClient.init();

        if (nativeAutomation)
            await this._setupNativeAutomation({ browserId: id, browserClient, runtimeInfo, nativeAutomationOptions: nativeAutomation });
    },

    async closeBrowser (id) {
        await this.openedBrowsers[id].ipc.terminateProcess();

        this.openedBrowsers[id].ipc.stop();

        delete this.openedBrowsers[id];
    },

    async getBrowserList () {
        return ['${PATH_TO_ELECTRON_APP}'];
    },

    // TODO: implement validation ?
    async isValidBrowserName (/* browserName */) {
        return true;
    },

    //Helpers
    async getMainMenuItems () {
        return ElectronBrowserProvider._getBrowserHelpers().getMainMenuItems();
    },


    async getContextMenuItems () {
        return ElectronBrowserProvider._getBrowserHelpers().getContextMenuItems();
    },

    async clickOnMainMenuItem (menuItem, modifiers = {}) {
        return ElectronBrowserProvider._getBrowserHelpers().clickOnMainMenuItem(menuItem, modifiers);
    },

    async clickOnContextMenuItem (menuItem, modifiers = {}) {
        return ElectronBrowserProvider._getBrowserHelpers().clickOnContextMenuItem(menuItem, modifiers);
    },

    async setElectronDialogHandler (fn, context) {
        return ElectronBrowserProvider._getBrowserHelpers().setElectronDialogHandler(fn, context);
    },

    async getMainMenuItem (menuItemSelector) {
        return ElectronBrowserProvider._getBrowserHelpers().getMainMenuItem(menuItemSelector);
    },

    async getContextMenuItem (menuItemSelector) {
        return ElectronBrowserProvider._getBrowserHelpers().getContextMenuItem(menuItemSelector);
    },

    async openFileProtocol (browserId, url) {
        const cdpClient = await this._getActiveCDPClient(browserId);

        await navigateTo(cdpClient, url);
    },

    async dispatchNativeAutomationEvent (browserId, type, options) {
        const cdpClient = await this._getActiveCDPClient(browserId);

        await dispatchNativeAutomationEvent(cdpClient, type, options);
    },

    async dispatchNativeAutomationEventSequence (browserId, eventSequence) {
        const cdpClient = await this._getActiveCDPClient(browserId);

        for (const event of eventSequence) {
            if (event.type === EventType.Delay)
                await this._delay(event.options.delay);
            else
                await dispatchNativeAutomationEvent(cdpClient, event.type, event.options);
        }
    },

    supportNativeAutomation () {
        return true;
    },
};

export { ElectronBrowserProvider as default };
