function hasValidArgsForMode(args) {
  if (args.mode === 'web' && args.passphrase.length > 0 && args.webUsername.length > 0 && args.webDomain.length > 0 && args.version > 0) {
    return true;
  } else if (args.mode === 'app' && args.passphrase.length > 0 && args.appName.length > 0 && args.version > 0) {
    return true;
  } else {
    return false;
  }

}

function processPassphrase(args) {

  var usernameOrAppname = '';

  if (args.webUsername !== '') {
    usernameOrAppname = args.webUsername;
  }

  if (args.appName !== '') {
    usernameOrAppname = args.appName;
  }

  usernameOrAppname.toLowerCase();

  // Estimate base password entropy with ZXCVBN
  // https://blogs.dropbox.com/tech/2012/04/zxcvbn-realistic-password-strength-estimation/
  // https://dl.dropboxusercontent.com/u/209/zxcvbn/test/index.html
  var zxcvbnPassphrase = zxcvbn(args.passphrase);

  var host = extractHostFromUri(args.webDomain);

  if (zxcvbnPassphrase.score >= 4 && hasValidArgsForMode(args)) {

    // Generate a master key w/ HMAC-SHA-256, from passphrase and username
    // Note : (Dmitry Chestnykh) Not hashing the passphrase in addition to the uname
    // will make masterKey from a passphrase longer than 128-bytes equal to
    // masterKey from the SHA512 of passphrase due to an HMAC quirk where it
    // compresses keys longer than the hash block.
    //
    // See https://twitter.com/dchest/status/421595430539894784 for example (for SHA1).
    //
    // If you want to avoid this non-important detail, you can, for example, pre-hash the passphrase.
    var passPhraseHashedUint8 = nacl.hash(nacl.util.decodeUTF8(args.passphrase)); // SHA-512, 64 Bytes
    var usernameOrAppnameUint8 = nacl.util.decodeUTF8(usernameOrAppname); // Byte Array
    var usernameOrAppnameHashedUint8 = nacl.hash(usernameOrAppnameUint8); // SHA-512, 64 Bytes
    var masterKeyUint8 = nacl.auth.full(passPhraseHashedUint8, usernameOrAppnameHashedUint8); // HMAC-SHA-512, 64 Bytes

    // Construct a salt for key derivation and pass it through SHA-512
    // Params should be delimited and length of segments included per Dmitry Chestnykh to avoid:
    //
    // username: ssl,
    // host: docs.google.com
    //
    // from equaling:
    //
    // username: ssl.docs
    // host: .google.com
    //
    var paramsCombined = usernameOrAppname.length + '.' + usernameOrAppname;

    if (host && host.length > 0) {
      paramsCombined = paramsCombined + '@' + host.length + '.' + host;
    }

    if (args.version && args.version > 0) {
      paramsCombined = paramsCombined + ':' + args.version.length + '.' + args.version;
    }

    if (args.salt && args.salt.length > 0) {
      paramsCombined = paramsCombined + ':' + args.salt.length + '.' + args.salt;
    }

    var paramsCombinedUint8 = nacl.util.decodeUTF8(paramsCombined); // Byte Array
    var kdSaltUint8 = nacl.hash(paramsCombinedUint8); // SHA-512, 64 Bytes

    // scrypt : https://www.tarsnap.com/scrypt.html
    //
    // On choosing optimal work factors:
    // https://stackoverflow.com/questions/11126315/what-are-optimal-scrypt-work-factors
    //
    // masterKeyUint8 = h(passphrase, usernameOrAppname)
    // kdSaltUint8 = h(usernameOrAppname | host | version | salt)
    // L bytes of derived key material from a password passwd and a salt salt
    // N, which must be a power of two, which will set the overall difficulty
    //   of the computation. The scrypt paper uses 2^14 = 16384 for interactive
    //   logins, and 2^20 = 1048576 for file encryption, but running in the
    //   browser is slow so Your Mileage Will Almost Certainly Vary.
    // r and p. r is a factor to control the blocksize for each mixing
    //   loop (memory usage). p is a factor to control the number of
    //   independent mixing loops (parallelism). Good values are
    //   r = 8 and p = 1. See the scrypt paper for details on these parameters.
    //   Choose wisely! Picking good values for N, r and p is important for
    //   making your keys sufficiently hard to brute-force.
    //
    var scrypt = scrypt_module_factory();
    var N = 16384; // 2^14 : 128×16384×8 = 16,777,216 bytes = 16 MB RAM, 16384 iterations.
    var r = 8; //
    var p = 1; //
    var L = 32; // Output Bytes
    var kdBytesUint8 = scrypt.crypto_scrypt(masterKeyUint8, kdSaltUint8, N, r, p, L);

    // calculate a symbol from last byte to ensure every generated password
    // has at least one symbol since the Base64 output doesn't guarantee.
    var lastByte = kdBytesUint8[31];
    var symbols = ['!', '@', '#', '$', '%', '?', '&', '*', '+', '-'];
    var symbolIndexForByte = lastByte % 10;
    var chosenSymbol = symbols[symbolIndexForByte];

    // calculate a number from second to last byte to ensure every generated
    // password has at least one number since the Base64 output doesn't guarantee.
    var secondToLastByte = kdBytesUint8[30];
    var numbers = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    var numberIndexForByte = secondToLastByte % 10;
    var chosenNumber = numbers[numberIndexForByte];

    // Convert the key derivation function output to Base 64 (does not include
    // extra number or symbol yet)
    var kdBytesBase64ForPass = nacl.util.encodeBase64(kdBytesUint8); // Base 64 String for password

    // Take only the first N bytes of the Base 64 encoded password as the final password.
    // Append a deterministically chosen symbol and number to ensure meeting most password requirements
    var password = kdBytesBase64ForPass.substring(0, 18) + chosenSymbol + chosenNumber; // Partial Base 64 String

    // Calc the estimated entropy of the final encoded password.
    var zxcvbnPassword = zxcvbn(password);

    return {
      usernameOrAppname: usernameOrAppname,
      host: host,
      password: password,
      version: args.version,
      salt: args.salt,
      passphraseEntropy: zxcvbnPassphrase.entropy,
      passwordCrackTime: zxcvbnPassword.crack_times_display.offline_fast_hashing_1e10_per_second,
    };
  } else {
    return null;
  }
}

// http://www.example.com/foo/index.html => www.example.com
// http://127.0.0.1/foo/index.html => 127.0.0.1
function extractHostFromUri(uri) {
  var domainMatcher = /^[a-zA-Z0-9][a-zA-Z0-9-]{1,61}[a-zA-Z0-9](?:\.[a-zA-Z]{2,})+$/;
  var ipMatcher = /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;

  // Extract the domain portion of the site URI
  // URI Parser : https://github.com/derek-watson/jsUri
  host = new Uri(uri).host();

  if (host && domainMatcher.test(host)) {
    return host;
  } else if (host && ipMatcher.test(host)) {
    return host;
  } else {
    return null;
  }
}

// FIXME : The output of this should be something you can write down to contain all of the settings used for this password.
// function computeSaltInWords(usernameOrAppname, domain, version, salt) {
//   if (usernameOrAppname && domain && version >= 1 && salt.length >= 1) {
//     return usernameOrAppname + '@' + domain + ':v' + version + ':*****';
// } else if (usernameOrAppname && domain && version >= 1 && salt === '') {
//     return usernameOrAppname + '@' + domain + ':v' + version ;
//   } else {
//     return null;
//   }
// }

function clearInputs() {
  $('#keyPassphraseInput').val('');
  $('#keyPassphraseInput').pwstrength('forceUpdate');
  $('#tokenInput').val('');
  $('#webUsernameInput').val('');
  $('#webDomainInput').val('');
  $('#appNameInput').val('');
  $('#versionInput').val(1);
}

function setWebMode() {
  $('#keyPassphraseInputGroup').slideDown(function() {
    $('#keyPassphraseInput').focus();
  });

  $('#tokenInputGroup').slideDown();
  $('#webUsernameInputGroup').slideDown();
  $('#webDomainInputGroup').slideDown();
  $('#appNameInputGroup').slideUp();
  $('#versionInputGroup').slideDown();
}

function setAppMode() {
  $('#keyPassphraseInputGroup').slideDown(function() {
    $('#keyPassphraseInput').focus();
  });

  $('#tokenInputGroup').slideDown();
  $('#webUsernameInputGroup').slideUp();
  $('#webDomainInputGroup').slideUp();
  $('#appNameInputGroup').slideDown();
  $('#versionInputGroup').slideDown();
}

function isWebMode() {
  if ($('#webModeButton').hasClass('active')) {
    return true;
  }
}

function isAppMode() {
  if ($('#appModeButton').hasClass('active')) {
    return true;
  }
}

// https://stackoverflow.com/questions/1909441/jquery-keyup-delay
var delay = (function() {
  var timer = 0;
  return function(callback, ms) {
    clearTimeout(timer);
    timer = setTimeout(callback, ms);
  };
})();

function updateOutputContainers() {
  // delay execution for a number of milliseconds after keyups stop.
  delay(function() {
    // force password strength update
    $('#keyPassphraseInput').pwstrength('forceUpdate');

    var passphrase = $.trim($('#keyPassphraseInput').val());
    var salt = $.trim($('#tokenInput').val());
    var webUsername = $.trim($('#webUsernameInput').val()).toLowerCase();
    var webDomain = $.trim($('#webDomainInput').val()).toLowerCase();
    var appName = $.trim($('#appNameInput').val()).toLowerCase();
    var version = parseInt($.trim($('#versionInput').val()));

    var mode;
    if (isWebMode()) {
      mode = 'web';
    } else if (isAppMode()) {
      mode = 'app';
    }

    var processPassphraseArgs = {
      mode: mode,
      passphrase: passphrase,
      salt: salt,
      webUsername: webUsername,
      webDomain: webDomain,
      appName: appName,
      version: version,
    };
    var securityObj = processPassphrase(processPassphraseArgs);

    if (isWebMode()) {
      updatePasswordOutputContainer(securityObj);
    } else if (isAppMode()) {
      updatePasswordOutputContainer(securityObj);
    }
  }, 500);
}

function updatePasswordOutputContainer(securityObj) {
  if (isWebMode() && securityObj && securityObj.usernameOrAppname && securityObj.host && securityObj.password) { // web mode
    $('#passwordOutput').text(securityObj.password);
    $('#passwordCrackTime').text(securityObj.passwordCrackTime);

    // $("#sanitizedSaltInWords").text(computeSaltInWords(securityObj.usernameOrAppname, securityObj.host, securityObj.version, securityObj.salt));
    $('#passwordOutputContainer').slideDown();
  } else if (isAppMode() && securityObj && securityObj.usernameOrAppname && securityObj.password) { // app mode
    $('#passwordOutput').text(securityObj.password);
    $('#passwordCrackTime').text(securityObj.passwordCrackTime);

    // $("#sanitizedSaltInWords").text(computeSaltInWords(securityObj.usernameOrAppname, securityObj.host, securityObj.version, securityObj.salt));
    $('#passwordOutputContainer').slideDown();
  }
}

$(document).ready(function() {
  'use strict';

  $('#inputForm').hide();
  $('#passwordOutputContainer').hide();

  // a click on any mode selector button
  $('.modeSelector').click(function() {
    $('.modeSelector').removeClass('active');
    $(this).addClass('active');
    $('#inputForm').slideDown();
    clearInputs();
    updateOutputContainers();
  });

  $('#webModeButton').click(function() {
    setWebMode();
  });

  $('#appModeButton').click(function() {
    setAppMode();
  });

  // Configure the password strength meter.
  // https://github.com/ablanco/jquery.pwstrength.bootstrap
  $('#keyPassphraseInput').pwstrength({
    ui: {
      showVerdictsInsideProgressBar: true,
    },
    common: {
      zxcvbn: true,
      zxcvbnTerms: ['secret', 'password'],
      userInputs: ['#webUsernameInput', '#webDomainInput', '#appNameInput', '#tokenInput'],
    },
  });

  // All form control elements keyup
  $('.form-control').on('keyup', function() {
    updateOutputContainers();
  });

  // Special handling for the HTML5 scroll arrows for a number field
  // https://stackoverflow.com/questions/5669207/html5-event-listener-for-number-input-scroll-chrome-only
  $('#versionInput').click(function() {
    updateOutputContainers();
  });

  $('#versionInput').change(function() {
    updateOutputContainers();
  });

  $('#versionInput').keypress(function() {
    updateOutputContainers();
  });

});
