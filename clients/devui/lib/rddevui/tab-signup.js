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
 *
 **/

define(
  [
    'wmsy/wmsy',
    'text!./tab-signup.css',
    'exports'
  ],
  function(
    $wmsy,
    $_css,
    exports
  ) {

// define our tab type in the tabs domain
var ty = exports.ty =
  new $wmsy.WmsyDomain({id: "tab-signup", domain: "tabs"});

// define our 'dashboard' widgets in the dashboard domain
var wy = exports.wy =
  new $wmsy.WmsyDomain({id: "tab-signup", domain: "moda"});

/**
 * Make a ViewSlice that hooks up to a LiveSet.
 */
function LiveSetListenerViewSliceAdapter(liveSet) {
  this._listener = null;
  this.data = null;
  this.liveSet = liveSet;
  liveSet._listener = this;
}
LiveSetListenerViewSliceAdapter.prototype = {
  seek: function() {
    if (this.liveSet.items.length)
      this._listener.didSplice(0, this.liveSet.items.length, this.liveSet.items,
                               true, false);
  },

  onSplice: function(index, howMany, addedItems, liveSet) {
    this._listener.didSplice(index, howMany, addedItem, true, false, this);
  },
};

ty.defineWidget({
  name: 'signup-tab',
  constraint: {
    type: 'tab',
    obj: { kind: 'signup' },
  },
  structure: {
    userInfoBlock: {
      userPoco: wy.widget({type: 'poco-edit'},
                          ['userAccount', 'poco']),
    },
    emailInfoBlock: {
      eiLabel: "browserid goes here.",
    },
    serverListBlock: {
      siLabel: "Pick a server to use:",
      servers: wy.vertList({type: 'server'}),
    },
    buttonBar: {
      btnSignup: wy.button("Signup"),
    },
  },
  impl: {
    postInit: function() {
      var moda = this.__context.moda;

      var serverSet = moda.queryServers(vs);
      var vs = new LiveSetListenerViewSliceAdapter(serverSet);
      this.servers_set(vs);
    },
  }
});

wy.defineWidget({
  name: 'poco-editor',
  constraint: {
    type: 'poco-edit',
  },
  structure: {
    dnLabel: { // want a wy.label for this.
      ldn0: "I want to be known to the world as ",
      displayName: wy.text('displayName'),
      ldn1: "."
    },
  },
});

wy.defineWidget({
  name: 'server-info',
  constraint: {
    type: 'server',
  },
  structure: {
    urlBlock: [
      'Server URL: ', wy.bind('url'),
    ],
    dnBlock: [
      'Server Description: ', wy.bind('displayName'),
    ],
  },
});

}); // end define
