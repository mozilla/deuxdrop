/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at:
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is Mozilla Raindrop Code.
 *
 * The Initial Developer of the Original Code is
 *   The Mozilla Foundation
 * Portions created by the Initial Developer are Copyright (C) 2011
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *   Andrew Sutherland <asutherland@asutherland.org>
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ***** */

/**
 * Moda test helper logic that constitutes a meta-representation and behaviour
 *  check of the moda representation.  It may seem silly, but it's much more
 *  comprehensive and reliable a way to do it than having a massive set of
 *  manually created permutations in the unit tests.  (Note, however, that we
 *  do need to make sure to actually create all the permutations that need
 *  to be tested in the unit test.)
 *
 * Our interaction with the moda layer is one of direct consumer which we then
 *  expose into the logging framework.
 *
 * Our knowledge of (expected) state is (intentionally) limited to what we infer
 *  from the actions taken by the testing layer in the test.  Specifically, we
 *  don't query the database to find out the (already) known contacts but rather
 *  rely on the test command to add a contact.  This is a desirable limitation
 *  because it avoids having our tests use broken circular reasoning, but it
 *  does mean that if we have a test that starts from database persisted state
 *  then the testing layer needs to be fed that expected state somehow.
 * A specific example of what we want to avoid is having broken program logic
 *  that nukes the contact database and then have the testing logic assume
 *  the user is supposed to have no contacts.  Obviously if our testing logic
 *  was written in a way that it nukes its expected set of contacts too,
 *  this will not help, but that's why we generate human understandable logs;
 *  so that the author can sanity check what actions the tests actually took
 *  and check the results.
 *
 * In general, we try and leverage the internal structures of the "testClient"
 *  and "thing" representations rather than building our own redundant shadow
 *  data structures.
 *
 * Our interaction with testClient/testServer is handled by registering ourself
 *  with the testClient instances so that when testClient expectation
 *  methods are invoked, it can call us so that we can contribute to test steps
 *  and optionally provide additional test steps.
 * For example, when sending a conversation message, all participanting
 *  testClients will have do_expectConvMessage invoked on them.  We can insert
 *  actions into the replica processing stage about what happens on the client
 *  non-UI logic thread with gated notifications to the UI thread, then
 *  introduce an additional step where we release the notifications to the UI
 *  thread.
 **/

define(function(require, exports, $module) {

var $Q = require('q'),
    when = $Q.when;

var $testdata = require('rdcommon/testdatafab');

var $log = require('rdcommon/log');

var $moda_api = require('rdcommon/moda/api'),
    $moda_backside = require('rdcommon/moda/backside'),
    $ls_tasks = require('rdcommon/rawclient/lstasks');

var $testwrap_backside = require('rdcommon/moda/testwrapper');

var fakeDataMaker = $testdata.gimmeSingletonFakeDataMaker();


/**
 * Traverse `list`, using the "id" values of the items in the list as keys in
 *  the dictionary `obj` whose values are set to `value`.
 */
function markListIntoObj(list, obj, value) {
  for (var i = 0; i < list.length; i++) {
    obj[list[i]] = value;
  }
}

/**
 * Assists in generating delta-expectation representations related to persistent
 *  queries.
 */
var DeltaHelper = exports.DeltaHelper = {
  makeEmptyDelta: function() {
    return {
      preAnno: {},
      state: {},
      postAnno: {},
    };
  },

  _PEEP_QUERY_KEYFUNC: function(x) { return x.rootKey; },

  _PEEP_QUERY_BY_TO_CMPFUNC: {
    alphabet: function(a, b) {
      if (!a.name)
        throw new Error("A is weird: " + JSON.stringify(a));
      return a.name.localeCompare(b.name);
    },
    any: function(a, b) {
      return a.any - b.any;
    },
    recip: function(a, b) {
      return a.recip - b.recip;
    },
    write: function(a, b) {
      return a.write - b.write;
    },
  },

  /**
   * Generate the delta rep for the initial result set of a peep query.
   */
  peepExpDelta_base: function(lqt, cinfos, queryBy) {
    var delta = this.makeEmptyDelta();

    lqt._cinfos = cinfos;
    lqt._sorter = this._PEEP_QUERY_BY_TO_CMPFUNC[queryBy];
    cinfos.sort(lqt._sorter);
    var rootKeys = cinfos.map(this._PEEP_QUERY_KEYFUNC);
    markListIntoObj(rootKeys, delta.state, null);
    markListIntoObj(rootKeys, delta.postAnno, 1);

    return delta;
  },

  /**
   * Generate the delta rep for a completely new contact.
   */
  peepExpDelta_added: function(lqt, newCinfo) {
    var delta = this.makeEmptyDelta();

    // -- preAnno
    // nothing to do for an addition; there are no removals

    // -- state / postAnno
    // - insert the cinfo, resort
    // (This is less efficient than finding the sort point via binary search, but
    //  since we may screw that logic up and that's how we do it for the actual
    //  impl, we want to do it a different way for the expectation.)
    var cinfos = lqt._cinfos;
    cinfos.push(newCinfo);
    cinfos.sort(lqt._sorter);

    // - generate state
    markListIntoObj(cinfos.map(this._PEEP_QUERY_KEYFUNC), delta.state, null);

    // - postAnno update for the inserted dude.
    delta.postAnno[this._PEEP_QUERY_KEYFUNC(newCinfo)] = 1;

    return delta;
  },
};

/**
 * There should be one moda-actor per moda-bridge.  So if we are simulating
 *  a desktop client UI that implements multiple tabs, each with their own
 *  moda bridge, then there should be multiple actor instances.
 */
var TestModaActorMixins = {
  __constructor: function(self, opts) {
    if (!opts.client)
      throw new Error("Moda actors must be associated with a client!");
    self._testClient = opts.client;
    self._testClient._staticModaActors.push(self);

    /** Dynamically updated list of contacts (by owning client). */
    self._dynamicContacts = [];
    self._dynamicContactInfos = [];
    self._contactMetaInfoByName = {};

    self._dynamicPeepQueries = [];

    self.T.convenienceSetup(self, 'initialize', function() {
      self._testClient._modaActors.push(self);

      // - create our self-corresponding logger, it will automatically hookup
      self._logger = LOGFAB.testModa(self, self._testClient._logger,
                                     self.__name);

      self._eBackside = self.T.actor('modaBackside', self.__name, null, self);
      self.RT.reportActiveActorThisStep(self._eBackside);

      self._notif = self._testClient._rawClient.store._notif;

      // - create the moda backside
      self._backside = new $moda_backside.ModaBackside(
                             self._testClient._rawClient, self.__name,
                             self._logger);

      // - create the moda bridge
      // (It has no logger and thus we create no actor; all its events get
      //   logged by us on our logger.)
      self._bridge = new $moda_api.ModaBridge();

      // - link backside and bridge (hackily)
      self._bridge._sendObjFunc = self._backside.XXXcreateBridgeChannel(
                                    self._bridge._receive.bind(self._bridge));
    });
  },

  //////////////////////////////////////////////////////////////////////////////
  // Shadow Contact Information

  /**
   * Retrieve our test-only contact info meta-structure from the perspective
   *  of the moda bridge.
   */
  _lookupContactInfo: function(contactTestClient) {
    return this._contactMetaInfoByName[contactTestClient.__name];
  },

  _getDynContactInfos: function() {
    return this._dynamicContactInfos.concat();
  },


  //////////////////////////////////////////////////////////////////////////////
  // Notifications from testClient

  /**
   * Invoked during the action step where the replica block is released to the
   *  client.  All data structure manipulations should be on dynamic ones.
   */
  __addingContact: function(other) {
    var nowSeq = this.RT.testDomainSeq;
    // -- populate our metadata for the contact
    // (most of this is for view ordering expectations)
    this._dynamicContacts.push(other);
    var newCinfo = this._contactMetaInfoByName[other.__name] = {
      rootKey: other._rawClient.rootPublicKey,
      // in our test we always use the testing name as the displayName
      name: other.__name,
      any: nowSeq,
      write: nowSeq,
      recip: nowSeq,
    };
    this._dynamicContactInfos.push(newCinfo);

    // -- generate expectations about peep query deltas
    var queries = this._dynamicPeepQueries;
    for (var iQuery = 0; iQuery < queries.length; iQuery++) {
      var lqt = queries[iQuery];

      // in the case of an addition we expect a positioned splice followed
      //  by a completion notification
      var deltaRep = DeltaHelper.peepExpDelta_added(lqt, newCinfo);

      this.RT.reportActiveActorThisStep(this);
      this.expect_queryCompleted(lqt.__name, deltaRep);
    }
  },

  __receiveConvWelcome: function(tConv) {
    // nb: tConv's backlog is a dynamic state correlated with the global
    //  conversation state as opposed to a snapshot at the time a welcome was
    //  issued.
    var backlog = tConv.data.backlog;
    for (var iMsg = 0; iMsg < backlog.length; iMsg++) {
      this.__receiveConvMessage(tConv, backlog[iMsg]);
    }
  },

  __receiveConvMessage: function(tConv, tMsg) {
    if (tMsg.type === 'message') {
      var ainfo = this._lookupContactInfo(tMsg.data.author);
      ainfo.write = Math.max(ainfo.write, tMsg.seq);
      ainfo.any = Math.max(ainfo.any, tMsg.seq);

      for (var iPart = 0; iPart < tConv.participants.length; iPart++) {
        var participant = tConv.participants[iPart];
        if (participant === this || participant === tMsg.data.author)
          continue;
        var pinfo = this._lookupContactInfo(participant);
        pinfo.recip = Math.max(pinfo.recip, tMsg.seq);
      }
    }
  },

  //////////////////////////////////////////////////////////////////////////////
  // LiveSet Listener handling
  //
  // We translate the notifications into an ordered state representation that
  //  uses only the root names of things.

  _remapLocalToFullName: function(namespace, localName) {
    return this._notif.mapLocalNameToFullName(this._backside._querySource,
                                              namespace,
                                              localName);
  },

  onItemsModified: function(items, liveSet) {
    var lqt = liveSet.data, delta;
    if (!lqt._pendingDelta)
      delta = lqt._pendingDelta = DeltaHelper.makeEmptyDelta();
    else
      delta = lqt._pendingDelta;

    for (var iModified = 0; iModified < items.length; iModified++) {
      var rootKey = this._remapLocalToFullName(liveSet._ns,
                                               items[iModified]._localName);
      // don't overwrite a +1 with a zero, leave it +1
      if (!delta.postAnno.hasOwnProperty(rootKey))
        delta.postAnno[rootKey] = 0;
    }
  },

  onSplice: function(index, howMany, addedItems, liveSet) {
    var lqt = liveSet.data, delta;
    if (!lqt._pendingDelta)
      delta = lqt._pendingDelta = DeltaHelper.makeEmptyDelta();
    else
      delta = lqt._pendingDelta;

    // - removals
    // this happens prior to actually performing the splice on the set's items
    var iRemoved = index, highRemoved = index + howMany, rootKey;
    for (; iRemoved < highRemoved; iRemoved++) {
      // (this is dealing with the moda 'user' visible representations)
      rootKey = this._remapLocalToFullName(liveSet._ns,
                                           liveSet.items[iRemoved]._localName);
      delta.preAnno[rootKey] = -1;
    }

    // - additions
    for (var iAdded = 0; iAdded < addedItems.length; iAdded++) {
      // (this is dealing with the wire rep)
      rootKey = this._remapLocalToFullName(liveSet._ns,
                                           addedItems[iAdded]._localName);
      delta.postAnno[rootKey] = 1;
    }

    // (state population happens during the completed notification)

    // XXX implement this, very similar to logic in `client-db-views.js`, steal.
    //this._logger.queryUpdateSplice(liveSet.data.__name, deltaRep);
  },

  onCompleted: function(liveSet) {
    var lqt = liveSet.data, delta, rootKey;
    if (!lqt._pendingDelta)
      delta = lqt._pendingDelta = DeltaHelper.makeEmptyDelta();
    else
      delta = lqt._pendingDelta;

    // - revised state
    for (var i = 0; i < liveSet.items.length; i++) {
      rootKey = this._remapLocalToFullName(liveSet._ns,
                                           liveSet.items[i]._localName);
      delta.state[rootKey] = null;
    }

    this._logger.queryCompleted(liveSet.data.__name, delta);
    lqt._pendingDelta = null;
  },

  //////////////////////////////////////////////////////////////////////////////
  // Queries: Issue
  //
  // Instantiate a new live query.  We check the results of the query (once
  //  concluded) to ensure that the results match the expected testing state.
  //  Additionally, all future test-induced state changes we hear about will
  //  have expectations generated for them.  Use `do_killQuery` when you are
  //  done with the query.

  /**
   * Issue and name a moda peeps query.
   */
  do_queryPeeps: function(thingName, query) {
    var lqt = this.T.thing('livequery', thingName), self = this;
    lqt._pendingDelta = null;

    this.T.action(this, 'create', lqt, function() {
      // -- generate the expectation
      // get and order the contact infos for generating the state; hold onto
      //  this.
      var delta = DeltaHelper.peepExpDelta_base(
                    lqt, self._getDynContactInfos(), query.by);
      self.expect_queryCompleted(lqt.__name, delta);

      lqt._liveset = self._bridge.queryPeeps(query, self, lqt);
      self._dynamicPeepQueries.push(lqt);
    });

    return lqt;
  },

  /**
   * Issue and name a moda conversations query on conversations involving a
   *  given peep.  To make things realistic, you need to provide us with a query
   *  that contains the peep in question so we can get the right reference.
   */
  do_queryPeepConversations: function(thingName, usingQuery, peepClient,
                                      query)  {
    var lqt = this.T.thing('livequery', thingName), self = this;
    lqt._pendingDelta = null;
    this.T.action(this, 'create', lqt, function() {
    });

    return lqt;
  },

  do_queryConversations: function(query) {

  },

  //////////////////////////////////////////////////////////////////////////////
  // Queries: Kill

  /**
   * Unsubscribe a live query and forget about it.  We structure our listeners
   *  so that if the live query logic screws up and keeps sending us events
   *  we will throw up errors.
   */
  do_killQuery: function() {
  },

  //////////////////////////////////////////////////////////////////////////////
  // Query Lookup Helpers

  _grabPeepFromQueryUsingClient: function(lqt, testClient) {
    var items = lqt._liveset.items;
    for (var i = 0; i < items.length; i++) {
      if (items[i].selfPoco.displayName === testClient.__name)
        return items[i];
    }
    throw new Error("Unable to map testClient '" + testClient.__name +
                    + "' back to a PeepBlurb instsance.");
  },

  _mapPeepsFromQueryUsingClients: function(lqt, testClients) {
    var peeps = [];
    for (var i = 0; i < testClients.length; i++) {
      this._grabPeepFromQueryUsingClient(lqt, testClients[i]);
    }
    return peeps;
  },

  //////////////////////////////////////////////////////////////////////////////
  // Actions

  /**
   * Create a conversation (using the moda API).  The entire testClient
   *  conversation creation set of steps is run, plus we wait for the
   *  moda representation updates once the conversation creation process
   *  makes it back to us.
   *
   * Right now the moda conversation creation API returns nothing useful
   *  to us about the conversation it created, and we won't hear about resulting
   *  blurbs etc. until after the conversation has hit the servers and come
   *  back to us.  We hackily address this
   */
  do_createConversation: function(tConv, tMsg, usingPeepQuery, recipients) {
    var youAndMeBoth = [this._testClient].concat(recipients);
    tConv.sdata = {
      participants: youAndMeBoth.concat(),
      fanoutServer: this._testClient._usingServer,
    };
    tConv.data = null;

    var messageText;

    var self = this;
    // - moda api transmission to bridge
    this.T.action('moda sends createConveration to', this._eBridge, function() {
      self.holdAllModaCommands();
      self.expectModaCommand('createConversation');

      messageText = fakeDataMaker.makeSubject();
      self._bridge.createConversation({
        peeps: self._mapPeepsFromQueryUsingClients(usingPeepQuery, recipients),
        text: messageText,
      });
    });
    // - bridge processes it
    this.T.action(this._eBridge, 'processes createConversation, invokes on',
                  this._testClient._eRawClient, function() {
      self._testClient._expect_createConversation_createPrep();

      var convCreationInfo = self.releaseAndPeekAtModaCommand(
                               'createConversation');
      self.stopHoldingAndAssertNoHeldModaCommands();

      self._testClient._expect_createConversation_rawclient_to_server(
        convCreationInfo, messageText, youAndMeBoth, tConv, tMsg);
    });

    // - fanout server onwards
    this._testClient._expdo_createConversation_fanout_onwards(tConv);
  },

  do_replyToConversationWith: function(tConv, tNewMsg) {
  },

  do_inviteToConversation: function(usingPeepQuery, invitedTestClient, tConv) {
  },

  //////////////////////////////////////////////////////////////////////////////
  // Notification Queries

  //////////////////////////////////////////////////////////////////////////////
  // Holding: Backside Communications

  holdAllModaCommands: function() {
    if (!("__hold_all" in this._backside))
      $testwrap_backside.modaBacksideWrap(this._backside);
    this._backside.__hold_all(true);
  },

  expectModaCommand: function(cmd) {
    this.expect_backsideReceived(cmd);
  },

  releaseAndPeekAtModaCommand: function(cmd) {
    return this._backside.__release_and_peek__received(cmd);
  },

  stopHoldingAndAssertNoHeldModaCommands: function() {
    this._backside.__hold_all(false);
  },

  //////////////////////////////////////////////////////////////////////////////
};

var LOGFAB = exports.LOGFAB = $log.register($module, {
  testModa: {
    // we are a client/server client, even if we are smart for one
    type: $log.TEST_SYNTHETIC_ACTOR,
    subtype: $log.CLIENT,
    topBilling: true,

    events: {
      queryCompleted: {name: true, keys: true},

      // - wrapper holds for the backside
      backsideReceived: {cmd: true},
    },
  },
});

exports.TESTHELPER = {
  // we leave it to the testClient TESTHELPER to handle most stuff, leaving us
  //  to just worry about moda.
  LOGFAB_DEPS: [LOGFAB,
    $moda_backside.LOGFAB, $ls_tasks.LOGFAB,
  ],

  actorMixins: {
    testModa: TestModaActorMixins,
  },
};

}); // end define
