/* @flow */

// Any copyright is dedicated to the Public Domain.
// http://creativecommons.org/publicdomain/zero/1.0/

import expect from 'expect';
import fetchMock from 'fetch-mock';

import configureStore from '../../../../../app/ui/browser/store/store';
import * as actions from '../../../../../app/ui/browser/actions/main-actions';
import * as utils from '../../../../utils/async';
import * as selectors from '../../../../../app/ui/browser/selectors';

import * as endpoints from '../../../../../app/shared/constants/endpoints';

describe('Action - unbookmark', () => {
  const session = 1;

  beforeEach(function() {
    this.store = configureStore();
    this.dispatch = this.store.dispatch;
    this.getState = () => this.store.getState().profile;
    this.getPages = () => selectors.getPages(this.store.getState());
    this.dispatch(actions.createTab('http://moz1.com'));
    expect(this.getPages().size).toEqual(1);

    // Set the session id directly since we don't have a UA server setting
    // this
    this.dispatch(actions.setPageDetails(this.getPages().get(0).id, {
      sessionId: session,
    }));
  });

  afterEach(fetchMock.reset);

  it('Should remove bookmarks from profile state', function() {
    const { dispatch, getState, getPages } = this;
    const pageId = getPages().get(0).id;

    expect(getState().get('bookmarks').has('http://moz1.com')).toEqual(false);
    dispatch(actions.bookmark(pageId, 'http://moz1.com', 'moz1'));
    expect(getState().get('bookmarks').has('http://moz1.com')).toEqual(true);
    dispatch(actions.unbookmark(pageId, 'http://moz1.com'));
    expect(getState().get('bookmarks').has('http://moz1.com')).toEqual(false);
  });

  it('Should send a message to the main process', async function() {
    const { dispatch, getPages } = this;
    const pageId = getPages().get(0).id;

    const URL = `^${endpoints.UA_SERVICE_HTTP}`; // Observe leading caret ^ (caret)!
    const expectedURL = `${endpoints.UA_SERVICE_HTTP}/stars/${encodeURIComponent('http://moz1.com')}`;

    fetchMock.mock(URL, 200);

    dispatch(actions.bookmark(pageId, 'http://moz1.com', 'moz1'));
    dispatch(actions.unbookmark(pageId, 'http://moz1.com'));

    await utils.waitUntil(() => fetchMock.lastUrl(URL) === expectedURL);

    expect(fetchMock.lastUrl(URL)).toEqual(expectedURL);
    expect(fetchMock.lastOptions(URL).method).toEqual('DELETE');
    expect(fetchMock.lastOptions(URL).json)
      .toEqual({ session });
  });
});
