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
 * Defines a an explicit task abstraction that is designed to execute a pipeline
 *  of simple asynchronous steps that always proceed in serial sequence.
 **/

define(
  [
    'q',
    'rdcommon/log',
    'exports'
  ],
  function(
    $Q,
    $log,
    exports
  ) {

const MAGIC_EARLY_RETURN = {};

var TaskProto = exports.TaskProto = {
  toString: function() {
    return '[Task:' + this.__name + ']';
  },
  toJSON: function() {
    return {type: 'Task:' + this.__name};
  },

  run: function() {
    this.__deferred = $Q.defer();
    this.__runNextStep(this.arg);
    return this.__deferred.promise;
  },

  __fail: function(err) {
    // iNextStep is always one beyond the most recent/current step...
    this.log.failed(this.__steps[this.__iNextStep - 1][0], err);
    // call the cleanup function safely-like
    if (this.__cleanup)
      this.log.cleaup(this, this.__cleanup);
    this.log.__die();
    this.__deferred.reject();
  },

  __succeed: function(val) {
    this.log.__die();
    this.__deferred.resolve(val);
  },

  __runNextStep: function(val) {
    // use a loop rather than tail-calls for synchronous steps...
    while (true) {
      // -- were we running a step?
      if (this.__iNextStep) {
        var lastStepMeta = this.__steps[this.__iNextStep - 1];
        // report the conclusion of the async step.
        this.log[lastStepMeta[4]]();
        if ($Q.isRejected(val)) {
          this.__fail();
          return;
        }
      }

      if (this.__iNextStep >= this.__steps.length) {
        this.__succeed(val);
        return;
      }

      var stepMeta = this.__steps[this.__iNextStep++];
      // generate the async begin entry
      this.log[stepMeta[3]]();
      // call the step function
      var rval = this.log[stepMeta[2]](this, stepMeta[1], val);
      // - synchronous failure
      if (rval instanceof Error) {
        this.log[stepMeta[4]]();
        this.__fail(); // no need to pass the exception since the call got it
        return;
      }
      // - it's async!
      else if ($Q.isPromise(rval)) {
        // nothing to do, wait for the step to conclude
        // XXX this is where we would want to consider a dead man's timeout...
        $Q.when(rval, this.__boundRunNextStep, this.__boundFail);
        return;
      }
      // - it's another task => async!
      else if (TaskProto.isPrototypeOf(rval)) {
        // initiate the task, treat it like any other promise
        $Q.when(rval.run(), this.__boundRunNextStep, this.__boundFail);
        return;
      }
      // - early return (only should be generated by early return tasks)
      else if (rval === MAGIC_EARLY_RETURN) {
        // effect the early return by jumping to the end
        this.__iNextStep = this.__steps.length;
        continue;
      }
      // - synchronous success
      else {
        // feed the returned value forward.
        val = rval;
        // (the next loop iteration will generate the async log _end too.)
        continue;
      }
    };
  },
};

var SoftFailureTaskProto = exports.SoftFailureTaskProto = {
  __proto__: TaskProto,
  __fail: function() {
    // iNextStep is always one beyond the most recent/current step...
    this.log.failed(this.__steps[this.__iNextStep - 1][0]);
    // call the cleanup function safely-like
    if (this.__cleanup)
      this.log.cleaup(this, this.__cleanup);
    this.log.__die();
    this.__deferred.resolve(false);
  },
  __succeed: function(val) {
    this.log.__die();
    this.__deferred.resolve(val);
  },
};

var EarlyReturnTaskProto = exports.EarlyReturnTaskProto = {
  __proto__: TaskProto,

  __succeed: function(val) {
    if (val === MAGIC_EARLY_RETURN) {
      val = this.__retVal;
    }
    this.log.__die();
    this.__deferred.resolve(val);
  },

  earlyReturn: function(val) {
    this.__retVal = val;
    return MAGIC_EARLY_RETURN;
  },
};

/**
 * Per-module task defining mechanism, where tasks are simple pipelines of
 *  asynchronous operations that we are standardizing for simplicity /
 *  consistency / logging / testing / understanding benefits.
 *
 * Our value-add over rolling your own is that we wrap all function calls in
 *  safe logger calls so we time and handle exceptions.  If your function
 *  throws, we declare the task failed and reject the associated promise.
 *
 * If you need something more complex (ex: branching), you may want to consider
 *  breaking your problem into sub-tasks where you can defer to one of multiple
 *  implementations.
 *
 * @typedef[TaskStepFunc @func[
 *   @args[]
 *   @return[@oneof[Promise Object]]
 * ]]{
 *   A task step function should return a promise if it is performing an
 *   asynchronous operation.  If anything but a promise is returned, it is
 *   assumed that the step has been satisfactorily completed.
 *
 *   If an exception is thrown, the task is declared to have failed; the
 *   cleanup function will be run if present, and the promise associated with
 *   the task will be rejected.
 *
 *   We intentionally do not allow a task constructor to be used as a special
 *   case, although it was strongly considered.  The rationale is that it is
 *   beneficial to have to explicitly specify the data that is to be passed in
 *   to the sub-task even if it is slightly more typing and the logger chain
 *   has to be manually maintained.
 * }
 * @typedef[TaskDef @dict[
 *   @key[name String]
 *   @key[args #:optional @listof[keyNames]]{
 *     If present, the creation argument is assumed to be a dictionary and this
 *     list of args is a white-list of keys whose values should be copied onto
 *     the object instance.
 *
 *     The decision to add this was made after "this.arg" started showing up
 *     like it was "this".
 *   }
 *   @key[steps @dictof[
 *     @key[stepName String]{
 *     }
 *     @value[stepFunc TaskStepFunc]{
 *     }
 *   ]]{
 *     The steps in the task.  We are relying on JS's ordered attribute
 *     semantics, so you need to not do anything that would mess that up.
 *   }
 *   @key[cleanup #:optional Function]{
 *     A synchronous function to run when the task is done, whether it be due to
 *     success or failure.  In the event of failure, not all steps may have run.
 *   }
 * ]]
 */
function TaskMaster(mod, logfab) {
  this._mod = mod;
  this._logfab = logfab;

  this.taskConstructorsByType = {};
}
TaskMaster.prototype = {
  toString: function() {
    return '[TaskMaster]';
  },
  toJSON: function() {
    return {type: 'TaskMaster'};
  },

  _commonDefineTask: function(taskDef, useTaskProto) {
    var stepName;

    // -- create the logger for the task type
    var loggerDefs = {}, loggerName = taskDef.name;
    var logDef = loggerDefs[taskDef.name] = {
      type: $log.TASK,
      subtype: $log.TASK, // figure it out from context, fancy pants.
      asyncJobs: {},
      calls: {},
      TEST_ONLY_calls: {},
      errors: {
        failed: {step: false, ex: $log.EXCEPTION},
      },
    };

    for (stepName in taskDef.steps) {
      logDef.asyncJobs[stepName] = {};
      logDef.calls[stepName + "_call"] = {};
      // The argument is definitely interesting, but may have complicated data
      //  structures in it.
      logDef.TEST_ONLY_calls[stepName + "_call"] = {arg: $log.RAWOBJ_DATABIAS};
    }

    if ("cleanup" in taskDef)
      logDef.calls.cleanup = {};

    $log.__augmentFab(this._mod, this._logfab, loggerDefs);

    // -- create the proto
    var steps = [];
    for (stepName in taskDef.steps) {
      var stepFunc = taskDef.steps[stepName];
      steps.push([stepName, stepFunc,
                  stepName + "_call",
                  stepName + "_begin", stepName + "_end"]);
    }

    var proto = {
      __proto__: useTaskProto,
      __name: taskDef.name,
      __steps: steps,
      __cleanup: ("cleanup" in taskDef ? taskDef.cleanup : null),
    };

    if ("impl" in taskDef) {
      for (var implKey in taskDef.impl)
        proto[implKey] = taskDef.impl[implKey];
    }
    var args;
    if ("args" in taskDef)
      args = taskDef.args;
    else
      args = null;

    var logfab = this._logfab;
    var taskConstructor = function $TaskConstructor(arg, _logger) {
      this.arg = arg;
      if (args) {
        for (var i = 0; i < args.length; i++) {
          var key = args[i];
          this[key] = arg[key];
        }
      }

      // XXX currently tasks are unnamed; we probably want to let a task def
      //  providing a naming description that gets passed through to the logging
      //  layer and a function that can extract the name from the arg payload.
      var name = null;
      this.log = logfab[loggerName](this, _logger, name);

      this.__iNextStep = 0;
      this.__pendingDeferred = null;

      this.__boundRunNextStep = this.__runNextStep.bind(this);
      this.__boundFail = this.__fail.bind(this);
    };
    taskConstructor.prototype = proto;

    this.taskConstructorsByType[taskDef.name] = taskConstructor;
    return taskConstructor;
  },

  defineTask: function(taskDef) {
    return this._commonDefineTask(taskDef, TaskProto);
  },

  /**
   * Define a task that resolves to false when it fails (because of a thrown
   *  exception) and otherwise behaves like a normal task (a successful
   *  return value is resolved as such).
   */
  defineSoftFailureTask: function(taskDef) {
    return this._commonDefineTask(taskDef, SoftFailureTaskProto);
  },

  /**
   * Define a task that can terminate early; call the `earlyReturn` method on
   *  the instance that takes the value to resolve and return its value to
   *  terminate early.
   *
   * Example: @js{return this.earlyReturn(actualReturnValue);}
   */
  defineEarlyReturnTask: function(taskDef) {
    return this._commonDefineTask(taskDef, EarlyReturnTaskProto);
  },
};

exports.makeTaskMasterForModule = function(mod, logfab) {
  return new TaskMaster(mod, logfab);
};

}); // end define
