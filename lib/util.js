const _ = require('underscore');
const colors = require('colors');
const domain = require('domain');
const readcommand = require('wolfy01-readcommand');
const sprintf = require('sprintf-js').sprintf;

/**
 * Determine if the given value is defined (i.e., isn't `null` or `undefined`)
 */
let isDefined = module.exports.isDefined = function(val) {
    return (val !== null && val !== undefined);
};

/**
 * Continuously prompt the user for commands while invoking each command they provide. The callback
 * is invoked when the user has exited.
 */
let doCommandLoop = module.exports.doCommandLoop = function(options, callback) {
    let session = options.session;
    let history = options.history || [];

    readcommand.loop({
        'input': session.stdin(),
        'output': session.stdout(),
        'ps1': _createPs(session, 'ps1'),
        'ps2': _createPs(session, 'ps2'),
        'autocomplete': _createAutocomplete(session),
        'history': history
    }, function(err, args, str, next) {
        if (err && err.code !== 'SIGINT') {
            // An unexpected error occurred
            throw err;
        } else if (err) {
            // User hit CTRL+C, just clear the prompt and jump to the next command
            return next();
        }

        args = _.compact(args);
        if (_.isEmpty(args)) {
            return next();
        }

        let commandName = args.shift();
        if (_.contains(args, '--help')) {
            // Show the help for the given command, just as if "help command" was invoked
            invokeCommand(session, 'help', [commandName], next);
        } else {
            // Invoke the executed command
            invokeCommand(session, commandName, args, function() {
                if (session._quit) {
                    // If the command quit the session, do not prompt for another command
                    return callback();
                }

                // Otherwise, we continue prompting
                return next();
            });
        }
    });
};

/*!
 * Programmatically invoke a command using the command name and parsed arguments. Note this function
 * ignores the state of `session.quit()` as quitting the session only impacts the user command loop
 */
let invokeCommand = module.exports.invokeCommand = function(session, commandName, args, callback) {
    if (commandName.match(/^\s*#/)) {
        // Commands that begin with a hash are commented out, ignore them
        return callback();
    }

    let command = session.commands().get(commandName);
    if (!command) {
        // If the command did not exist, show the command list
        // on stderr and prepare for the next command
        session.stderr().write('Invalid command: '.red + commandName.white + '\n');
        session.stderr().write('\n\n');
        return invokeCommand(session, 'help', ['--stderr'], callback);
    }

    // Wrap the invocation into a domain to catch any errors that are thrown from the command
    let commandDomain = domain.create();
    commandDomain.once('error', function(err) {
        // Hand any errors over to the error handler
        return _handleError(err, session, callback);
    });

    // Make the domain active, then inactive immediately after the command has returned
    commandDomain.enter();
    command.invoke(session, args, function(err) {
        commandDomain.exit();

        // Hand any errors over to the error handler
        if (err) {
            return _handleError(err, session, callback);
        }

        return callback();
    });
};

function _handleError(err, session, next) {
    // Get the first applicable handler
    let handlersForType = _.chain(session.errorHandlers())
        .filter(function(handlersForType) {
            return (err instanceof handlersForType.type);
        })
        .first()
        .value();
    if (!handlersForType) {
        throw err;
    }

    // Resolve the handler for this error based on code match in priority order
    let handler =
        _matchString(err, handlersForType['string']) ||
        _matchRegExp(err, handlersForType['regexp']) ||
        _matchFunction(err, handlersForType['function']) ||
        _matchNull(err, handlersForType['null']);

    // If we could not find a handler that matches this we promote the error
    if (!handler) {
        throw err;
    }

    // Invoke the handler we found
    return handler(err, session, next);
}

function _matchString(err, matches) {
    if (!_.isString(err.code)) {
        return;
    }

    let handler = null;
    _.each(matches, function(matchAndHandler) {
        if (_.isFunction(handler)) {
            return;
        } else if (!_.isString(matchAndHandler.codeMatch)) {
            return;
        } else if (err.code === matchAndHandler.codeMatch) {
            handler = matchAndHandler.handler;
        }
    });

    return (_.isFunction(handler)) ? handler : null;
}

function _matchRegExp(err, matches) {
    if (!_.isString(err.code)) {
        return;
    }

    let handler = null;
    _.each(matches, function(matchAndHandler) {
        if (_.isFunction(handler)) {
            return;
        } else if (!_.isRegExp(matchAndHandler.codeMatch)) {
            return;
        } else if (matchAndHandler.codeMatch.test(err.code)) {
            handler = matchAndHandler.handler;
        }
    });

    return (_.isFunction(handler)) ? handler : null;
}

function _matchFunction(err, matches) {
    let handler = null;
    _.each(matches, function(matchAndHandler) {
        if (_.isFunction(handler)) {
            return;
        } else if (!_.isFunction(matchAndHandler.codeMatch)) {
            return;
        } else if (matchAndHandler.codeMatch(err.code)) {
            handler = matchAndHandler.handler;
        }
    });

    return (_.isFunction(handler)) ? handler : null;
}

function _matchNull(err, matches) {
    let handler = null;
    _.each(matches, function(matchAndHandler) {
        if (_.isFunction(handler)) {
            return;
        } else if (!_.isFunction(matchAndHandler.handler)) {
            return;
        } else {
            handler = matchAndHandler.handler;
        }
    });

    return (_.isFunction(handler)) ? handler : null;
}

/*!
 * Return a function that returns the ps1 or ps2 prompt label, depending on `psVar`
 */
function _createPs(session, psVar) {
    return function() {
        return sprintf(session.env(psVar), session.env());
    };
}

/*!
 * Create an autocompleter function that autocompletes based on the commands in the session
 */
function _createAutocomplete(session) {
    return function(args, callback) {
        args = args.slice();

        // First handle the case where this is an auto-suggest based on finding the command name
        let allCommandNames = _.keys(session.commands().get());
        if (_.isEmpty(args)) {
            return callback(null, allCommandNames);
        } else if (args.length === 1) {
            return callback(null, _.filter(allCommandNames, function(commandName) {
                return (commandName.indexOf(args[0]) === 0);
            }));
        }

        // We presumably have a command argument already, feed the remaining arguments into the
        // commands autocomplete implementation
        let commandName = args.shift();
        let command = session.commands().get(commandName);
        if (command && _.isFunction(command.autocomplete)) {
            return command.autocomplete(session, args, callback);
        }

        return callback(null, []);
    };
}
