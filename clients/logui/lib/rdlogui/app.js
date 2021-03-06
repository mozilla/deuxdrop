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
 * Very simple log visualization (for now) that reuses/abuses the test results
 *  display to make it look like each time-slice interval we receive from the
 *  client daemon process is a test case step.  Visually, these are little
 *  collapsed boxes that are colored based on whether any errors were reported
 *  inside the box; clicking on the boxes expands them and shows the log entries
 *  from that time-slice.
 *
 * For maximum implementation simplicity, we treat each log slice as a
 *  completely independent log thing, but ideally we might perform some type of
 *  unification so that we could provide more advanced analytic features.
 **/

define(
  [
    'xmlhttprequest',
    'wmsy/wmsy',
    'wmsy/viewslice-array',
    'wmsy/wlib/objdict',
    'wmsy/wlib/popup',
    'arbcommon/chew-loggest',
    'arbclient/ui-loggest',
    'text!./app.css',
    'exports'
  ],
  function(
    $xmlhttprequest,
    $wmsy,
    $vs_array,
    $_wlib_objdict, // dependency for side effect
    $_wlib_popup, // dep for side effect
    $chew_loggest,
    $ui_loggest,
    $_css,
    exports
  ) {

// for simplicity vis-a-vis the popup, we need to be in the loggest domain
var wy = exports.wy =
  new $wmsy.WmsyDomain({id: "app", domain: "loggest", css: $_css});

wy.defineWidget({
  name: "root",
  focus: wy.focus.domain.vertical("perms"),
  constraint: {
    type: "root",
  },
  popups: {
    details: {
      constraint: {
        type: "popup-obj-detail"
      },
      clickAway: true,
      popupWidget: wy.libWidget({type: "popup"}),
      position: {
        above: "root",
      },
      size: {
        maxWidth: 0.9,
        maxHeight: 0.9,
      }
    }
  },
  structure: {
    perms: wy.vertList({type: 'fake-perm'}, 'vsPerms'),
  },
  impl: {
    /**
     * Rather than have every log atom be able to trigger a popup or require
     *  them to emit something on click, we just provide our own click handler
     *  that checks if the bindings want to have their data shown in a pop-up
     *  (which is generically parameterized anyways).
     */
    maybeShowDetailForBinding: function(binding) {
      if ("SHOW_DETAIL" in binding && binding.SHOW_DETAIL) {
        var detailAttr = binding.SHOW_DETAIL;
        var obj = binding.obj;
        // extremely simple traversal
        if (detailAttr !== true)
          obj = obj[detailAttr];
        this.popup_details(obj, binding);
      }
    },
  },
  events: {
    root: {
      click: function(binding) {
        this.maybeShowDetailForBinding(binding);
      }
    },
  },
});

wy.defineWidget({
  name: "fake-perm",
  focus: wy.focus.container.vertical("steps"),
  constraint: {
    type: "fake-perm",
  },
  provideContext: {
    permutation: wy.SELF,
  },
  structure: {
    steps: $ui_loggest.wy.vertList({type: 'test-step'}, 'steps'),
  },
});


function LogUIApp() {
  this.transformer = null;
  this._earliestStamp = null;

  this.fakePerms = [];
  this.vsPerms = new $vs_array.ArrayViewSlice(this.fakePerms);

  this.useNamesMap = null;
}
LogUIApp.prototype = {
  processSchema: function(schema) {
    this.transformer = new $chew_loggest.LoggestLogTransformer();
    this.transformer.processSchemas(schema);
  },

  /**
   * Process the logger, abusing a fair amount of the `chew-loggest.js`
   *  internals to enclose the logger in a fake test hierarchy.
   */
  processLogSlice: function(logslice) {
    if (this._earliestStamp === null)
      this._earliestStamp = logslice.begin;

    var transformer = this.transformer;
    var rootLogger = logslice.logFrag;

    // XXX in theory we might be provided with names by the server and so we
    //  should merge things, but for now it's known to not be the case.
    if (this.useNamesMap)
      rootLogger.named = this.useNamesMap;

    var fakePerm = new $chew_loggest.TestCasePermutationLogBundle({});
    transformer._uniqueNameMap = fakePerm._uniqueNameMap;
    transformer._usingAliasMap = fakePerm._thingAliasMap;
    transformer._connectionNameMap = fakePerm._connectionNameMap;
    transformer._baseTime = logslice.begin;

    var label = [Math.floor((logslice.begin - this._earliestStamp) / 1000) +
      'ms - ' +
      Math.floor((logslice.end - this._earliestStamp) / 1000) + 'ms'];
    var fakeStep = new $chew_loggest.TestCaseStepMeta(
                     label, { latched: {result: 'pass', boring: false} }, []);
    fakePerm.steps.push(fakeStep);

    // we are only putting one step in...
    var rows = fakePerm._perStepPerLoggerEntries,
        timeSpans = [[logslice.begin, logslice.end]];
    rows.push([]);
    rows.push([]);

    var rootLoggerMeta = transformer._createNonTestLogger(
                           rootLogger, fakePerm.loggers, fakePerm);
    // only one family!
    rootLoggerMeta.brandFamily('a');
    transformer._processNonTestLogger(rootLoggerMeta, rows, timeSpans);

    // splice it in, yos
    this.vsPerms.mutateSplice(this.fakePerms.length, 0, fakePerm);
  },

  receiveMessage: function(msg) {
    if (msg.type === 'logslice') {
      this.processLogSlice(msg.slice);
    }
    else if (msg.type === 'backlog') {
      this.processSchema(msg.schema);
      for (var i = 0; i < msg.backlog.length; i++) {
        this.processLogSlice(msg.backlog[i]);
      }
    }
    else if (msg.type === 'url') {
      this.useNamesMap = msg.annoFrag.named;
      remoteFetch(this, msg.url);
    }
    else {
      throw new Error("Unknown message type from logger: " + msg.type);
    }
  },
};

function sendMessageToClientDaemon(data) {
  var event = document.createEvent("MessageEvent");
  event.initMessageEvent('moda-ui-to-daemon', false, false,
                         JSON.stringify(data), '*', null, null, null);
  window.dispatchEvent(event);
}

function remoteFetch(app, url) {
  var request = new $xmlhttprequest.XMLHttpRequest();

  request.open('GET', url, true);

  var self = this;
  request.onreadystatechange = function(evt) {
    if (request.readyState == 4) {
      if (request.status == 200) {
        app.receiveMessage(JSON.parse(request.responseText));
      } else {
        console.error("Problem loading loggest data from", url);
      }
    }
  };
  request.send(null);
}

exports.main = function(doc) {
  var app = new LogUIApp();

  // Listen for messages from the client daemon
  window.addEventListener('moda-daemon-to-ui', function (evt) {
    var data = JSON.parse(evt.data);
    app.receiveMessage(data);
  }, false);

  // bind the UI into existence.
  var binder = wy.wrapElement(doc.getElementById("body"));
  binder.bind({type: "root", obj: app});

  sendMessageToClientDaemon({type: 'subscribe'});
};


}); // end define
