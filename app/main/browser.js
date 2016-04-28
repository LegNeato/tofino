/* @flow */

/*
Copyright 2016 Mozilla

Licensed under the Apache License, Version 2.0 (the "License"); you may not use
this file except in compliance with the License. You may obtain a copy of the
License at http://www.apache.org/licenses/LICENSE-2.0
Unless required by applicable law or agreed to in writing, software distributed
under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR
CONDITIONS OF ANY KIND, either express or implied. See the License for the
specific language governing permissions and limitations under the License.
*/

/* eslint import/imports-first: "off" */
// Must go before any require statements.
const browserStartTime = Date.now();

/* eslint no-console: 0 */

process.on('uncaughtException', (err) => {
  console.log(err.stack);
  process.exit(1);
});

process.on('unhandledRejection', (reason, p) => {
  console.log(`Unhandled Rejection at: Promise ${JSON.stringify(p)}, reason: ${reason.stack}`);
  process.exit(2);
});

import path from 'path';
import electron from 'electron';
import electronLocalshortcut from 'electron-localshortcut';

import BrowserMenu from './browser-menu';
import * as instrument from '../services/instrument';
import * as profileCommands from '../shared/profile-commands';
import * as profileDiffs from '../shared/profile-diffs';
import configureStore from './store/store';
import { ProfileStorage } from '../services/storage';
import profileCommandHandler from './reducers/profile-command-reducers';
const profileStoragePromise = ProfileStorage.open(path.join(__dirname, '..', '..'));
import * as profileActions from './actions/profile-actions';
import Immutable from 'immutable';

const BrowserWindow = electron.BrowserWindow;  // create native browser window.
const app = electron.app; // control application life.
const ipc = electron.ipcMain;
const globalShortcut = electron.globalShortcut;

const uiDir = path.join(__dirname, '..', 'ui');

const store = configureStore();
let currentState;

function sendToAllWindows(event: string, args: Object): void {
  console.log(`browser.js: sendToAllWindows ${JSON.stringify(args)}`);
  const windows = store.getState().browserWindows;

  if (!windows) {
    return;
  }

  windows.forEach((id) => {
    const bw = BrowserWindow.fromId(id);
    if (bw) {
      bw.webContents.send(event, args);
    }
  });
}

function sendDiffsToWindows(): void {
  const previousState = currentState;
  currentState = store.getState();

  // TODO: handle empty state.
  if (previousState && !Immutable.is(currentState.browserWindows,
                                     previousState.browserWindows)) {
    // Show new windows, taking care to use key IDs rather than possibly deleted ID members.
    currentState.browserWindows.forEach((id) => {
      if (previousState.browserWindows.has(id)) {
        return;
      }
      const bw = BrowserWindow.fromId(id);
      if (bw) {
        bw.didFinishLoadPromise.then(() => bw.show());
      }
    });

    // Close old windows, taking care to use key IDs rather than possibly deleted ID members.
    previousState.browserWindows.forEach((id) => {
      if (currentState.browserWindows.has(id)) {
        return;
      }
      const bw = BrowserWindow.fromId(id);
      if (bw) {
        bw.didFinishLoadPromise.then(() => bw.close());
      }
    });
  }

  const recentBookmarksChanged =
    !previousState ||
    !Immutable.is(currentState.recentBookmarks, previousState.recentBookmarks);

  if (recentBookmarksChanged) {
    BrowserMenu.build({ recentBookmarks: currentState.recentBookmarks });
  }

  const bookmarksChanged =
    !previousState ||
    !Immutable.is(currentState.bookmarks, previousState.bookmarks);

  if (bookmarksChanged) {
    sendToAllWindows('profile-diff', profileDiffs.bookmarks(currentState.bookmarks.toJS()));
  }

  const locationsChanged =
    !previousState ||
    !Immutable.is(currentState.locations, previousState.locations);

  if (locationsChanged) {
    sendToAllWindows('profile-diff', profileDiffs.completions(currentState.locations.toJS()));
  }
}

store.subscribe(sendDiffsToWindows);

function fileUrl(str: string): string {
  let pathName = path.resolve(str).replace(/\\/g, '/');

  // Windows drive letter must be prefixed with a slash
  if (pathName[0] !== '/') {
    pathName = `/${pathName}`;
  }

  return encodeURI(`file://${pathName}`);
}

async function makeBrowserWindow(tabInfo: ?Object): Promise<electron.BrowserWindow> {
  const profileStorage = await profileStoragePromise;
  const sessionId = await profileStorage.startSession(); // TODO: scope, ancestor.

  // Create the browser window.
  const browser = new BrowserWindow({
    center: false,
    width: 1366,
    height: 768,
    minWidth: 512,
    minHeight: 128,
    frame: false,
    show: false,
  });
  browser.sessionId = sessionId;

  browser.didFinishLoadPromise = new Promise((resolve, _reject) => {
    browser.webContents.once('did-finish-load', () => {
      const browserDidFinishLoadTime = Date.now();
      instrument.event('browser', 'READY', 'ms', browserDidFinishLoadTime - browserStartTime);

      if (tabInfo) {
        browser.webContents.send('tab-attach', tabInfo);
      }

      resolve();
    });
  });

  // Start loading browser chrome.
  browser.loadURL(fileUrl(path.join(uiDir, 'browser', 'browser.html')));

  electronLocalshortcut.register(browser, 'CmdOrCtrl+L', () => {
    browser.webContents.send('focus-url-bar');
  });

  electronLocalshortcut.register(browser, 'CmdOrCtrl+R', () => {
    browser.webContents.send('page-refresh');
  });

  return browser;
}

async function dispatchProfileCommand(
    command: Object,
    browserWindow: ?electron.BrowserWindow = null): Promise<void> {
  const profileStorage = await profileStoragePromise;
  await profileCommandHandler(profileStorage, store.dispatch, browserWindow,
                              makeBrowserWindow, command);
}

const appStartupTime = Date.now();
instrument.event('app', 'STARTUP');

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
app.on('ready', async function() {
  const appReadyTime = Date.now();
  instrument.event('app', 'READY', 'ms', appReadyTime - appStartupTime);

  // Extract the initial state from the profile storage.
  const profileStorage = await profileStoragePromise;
  const starredLocations = await profileStorage.starred();
  const recentlyStarredLocations = await profileStorage.recentlyStarred();
  store.dispatch(profileActions.bookmarkSet(new Immutable.Set(starredLocations)));
  store.dispatch(profileActions.recentBookmarks(new Immutable.List(recentlyStarredLocations)));

  dispatchProfileCommand(profileCommands.newBrowserWindow());
});

// Unregister all shortcuts.
app.on('will-quit', () => globalShortcut.unregisterAll());

// Quit when all windows are closed.
app.on('window-all-closed', () => {
  // On OS X it is common for applications and their menu bar
  // to stay active until the user quits explicitly with Cmd + Q
  if (process.platform !== 'darwin') {
    app.quit();
  }

  // Set a simple menu since all browser windows are closed.
  BrowserMenu.default();
});

app.on('activate', async function() {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (store.getState().browserWindows.isEmpty()) {
    dispatchProfileCommand(profileCommands.newBrowserWindow());
  }
});

ipc.on('instrument-event', (event, args) => {
  // Until we transpile app/, we can't destructure in the argument list or inline here.
  instrument.event(args.name, args.method, args.label, args.value);
});

// Inject initial state into the window. Eventually this will behave like session restore.
// Whenever you add something to the app state, make sure to also add it here.

ipc.on('window-loaded', (event) => {
  const bookmarkSet = store.getState().bookmarks || Immutable.Set();
  const recentBookmarks = store.getState().recentBookmarks || Immutable.List();
  event.returnValue = {
    bookmarks: bookmarkSet.toJS(),
    recentBookmarks: recentBookmarks.toJS(),
  };
});

ipc.on('window-ready', event => {
  const bw = BrowserWindow.fromWebContents(event.sender);
  if (bw) {
    bw.show();
  }
});

ipc.on('tab-detach', async function(event, tabInfo) {
  const browserWindow = await makeBrowserWindow(tabInfo);
  store.dispatch(profileActions.createBrowserWindow(browserWindow));
});

ipc.on('profile-command', async function(event, command) {
  // Not all events come from a window.  Some come from the main process.
  const browserWindow = (event && event.sender)
      ? BrowserWindow.fromWebContents(event.sender)
      : null;
  await dispatchProfileCommand(command, browserWindow);
});
