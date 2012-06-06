var URL_FAVICON_REPLACEMENTS = {
    'chrome://chrome/extensions': '/images/favicon/extensions.png',  // Chrome 19 and earlier
    'chrome://chrome/extensions/': '/images/favicon/extensions.png', // Chrome 20 early versions
    'chrome://extensions/': '/images/favicon/extensions.png',        // Chrome 20 later versions+
    'chrome://chrome/settings/': '/images/favicon/settings.png',     // Chrome 19 & 20 early versions
    'chrome://settings/': '/images/favicon/settings.png'             // Chrome 20 later versions
};
URL_FAVICON_REPLACEMENTS[chrome.extension.getURL('/options.html')] = '/images/sidewise_icon_16.png';

var URL_TITLE_REPLACEMENTS = {
    'chrome://chrome/extensions': getMessage('text_Extensions'),
    'chrome://chrome/extensions/': getMessage('text_Extensions'),
    'chrome://extensions/': getMessage('text_Extensions')
};


function getBestFavIconUrl(favIconUrl, url) {
    var replacedFavicon = URL_FAVICON_REPLACEMENTS[url];

    if (replacedFavicon) {
        return replacedFavicon;
    }

    if (favIconUrl && favIconUrl != '') {
        return favIconUrl;
    }

    return 'chrome://favicon/';
}

function getChromeFavIconUrl(url) {
    return 'chrome://favicon/' + dropUrlHash(url);
}

function isStaticFavIconUrl(favIconUrl) {
    if (!favIconUrl) {
        return false;
    }
    if (favIconUrl == '') {
        return false;
    }
    if (favIconUrl.indexOf('chrome://favicon') == 0) {
        return false;
    }
    return true;
};

function getBestPageTitle(title, url) {
    var replacedTitle = URL_TITLE_REPLACEMENTS[url];

    if (replacedTitle) {
        return replacedTitle;
    }

    if (title && title != '') {
        return title;
    }

    return url;
}

function injectContentScriptInExistingTabs(url)
{
    readFile(url, injectScriptInExistingTabs);
}

function injectScriptInExistingTabs(script)
{
    chrome.tabs.query({}, function(tabs) {
        for (var i in tabs) {
            var tab = tabs[i];
            log('Injecting script into tab', tab.id, tab.url);
            executeContentScript(tab.url, tab.id, script);
        }
    });
}

function readFile(url, callback)
{
    var xhr = new XMLHttpRequest();
    try {
        xhr.onreadystatechange = function(){
            if (xhr.readyState != 4) {
                return;
            }

            if (xhr.responseText) {
                callback(xhr.responseText);
            }
            else {
                throw 'No data returned for readFile: ' + url;
            }
        }

        xhr.onerror = function(error) {
            console.error(error);
        }

        xhr.open("GET", url, true);
        xhr.send(null);
    } catch(e) {
        console.error(e);
    }
}

function isScriptableUrl(url)
{
    // log(url);
    return !(url == ''
        || url.match('^(about|file|view-source|chrome.*):')
        || url.match('^https?://chrome.google.com/webstore')
    );
}

function isExtensionUrl(url)
{
    return url.indexOf(chrome.extension.getURL('/')) == 0;
}

function executeContentScript(url, tabId, scriptBody)
{
    if (isScriptableUrl(url))
    {
        log_brief(tabId, scriptBody);
        chrome.tabs.executeScript(tabId, { code: scriptBody });
    }
}

function splitUrl(url)
{
    var r = {};
    var m = url.match(/(?:()(www\.[^\s\/?#]+\.[^\s\/?#]+)|([^\s:\/?#]+):\/\/([^\s\/?#]*))([^\s?#]*)(?:\?([^\s#]*))?(?:#(\S*))?/);

    if (m)
    {
        r.protocol = m[3];
        r.host = m[4];
        r.path = m[5];
        r.query = m[6];
        r.hash = m[7];
        var m = r.host.match(/([^\.]+\.(org|com|net|info|[a-z]{2,3}(\.[a-z]{2,3})?))$/);
        r.domain = m ? m[0] : r.host;
        return r;
    }

    // that didn't work, try about:foo format
    m = url.match(/(.+):(.+)/)
    {
        r.protocol = 'about';
        r.host = 'memory';
        return r;
    }


}

function dropUrlHash(url)
{
    return url.replace(/#.*$/, '');
}

function getClampedWindowDimensions(left, top, width, height, minLeft, minTop, maxWidth, maxHeight)
{
    left = clamp(left, minLeft, minLeft + maxWidth);
    top = clamp(top, minTop, minTop + maxHeight);
    width = clamp(width, 0, maxWidth);
    height = clamp(height, 0, maxHeight);
    r = {left: left, top: top, width: width, height: height};
    return r;
}

function clone(obj) {
    // Handle the 3 simple types, and null or undefined
    if (null == obj || "object" != typeof obj) return obj;

    // Handle Date
    if (obj instanceof Date) {
        var copy = new Date();
        copy.setTime(obj.getTime());
        return copy;
    }

    // Handle Array
    if (obj instanceof Array) {
        var copy = [];
        var len = obj.length;
        for (var i = 0; i < len; ++i) {
            copy[i] = clone(obj[i]);
        }
        return copy;
    }

    // Handle Object
    if (obj instanceof Object) {
        var copy = {};
        for (var attr in obj) {
            if (obj.hasOwnProperty(attr)) copy[attr] = clone(obj[attr]);
        }
        return copy;
    }

    throw new Error("Unable to copy obj! Its type isn't supported.");
}

// Array Remove - By John Resig (MIT Licensed)
function remove(array, from, to) {
    var rest = array.slice((to || from) + 1 || array.length);
    array.length = from < 0 ? array.length + from : from;
    return array.push.apply(array, rest);
};

function clamp(value, min, max)
{
    value = value < min ? min : value;
    value = value > max ? max : value;
    return value;
}

/**
 * A function used to extend one class with another
 *
 * @param {Object} subClass
 *      The inheriting class, or subclass, which may have its own prototype methods
 * @param {Object} baseClass
 *      The class from which to inherit
 */
function extend(subClass, baseClass) {
   function inheritance() {}
   inheritance.prototype = baseClass.prototype;

   var subPrototype = Object.create(subClass.prototype);

   subClass.prototype = new inheritance();
   subClass.prototype.constructor = subClass;
   subClass._base = baseClass;
   subClass._super = baseClass.prototype;

   for (var attrname in subPrototype) {
       subClass.prototype[attrname] = subPrototype[attrname];
   }
}

Function.prototype.extendsClass = function(baseClass, withPrototype) {
    function inheritance() {}
    inheritance.prototype = baseClass.prototype;

    this.prototype = new inheritance();
    this.prototype.constructor = this;
    this._base = baseClass;
    this._super = baseClass.prototype;

    if (withPrototype === undefined) {
        return;
    }

    for (var attrname in withPrototype) {
        this.prototype[attrname] = withPrototype[attrname];
    }
}

