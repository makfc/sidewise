"use strict";

// ========================================================
// Tab/window-to-PageTreeNode assocation functions.
//
// Used to map session-restored tabs to existing rows.
// ========================================================

///////////////////////////////////////////////////////////
// Constants
///////////////////////////////////////////////////////////

var ASSOCIATE_PAGES_CHECK_INTERVAL_MS = 1000;
var ASSOCIATE_PAGES_CHECK_INTERVAL_MS_SLOW = 10000;
var ASSOCIATE_STUBBORN_TAB_FALLBACK_THRESHOLD_MS = 15000;

var ASSOCIATE_STUBBORN_TAB_FALLBACK_THRESHOLD_ITERATIONS =
    ASSOCIATE_STUBBORN_TAB_FALLBACK_THRESHOLD_MS / ASSOCIATE_PAGES_CHECK_INTERVAL_MS;

var CLEANUP_AFTER_ASSOCIATION_RUN_DELAY_MS = 500;
var CLEANUP_AFTER_ASSOCIATE_EXISTING_PAGE_DELAY_MS = 5000;

var ASSOCIATE_GET_DETAILS_MAX_RETRIES = 30;
var ASSOCIATE_GET_DETAILS_RETRY_WAIT_MS = 1500;

// When the referrer of a tab matches this regular expression, Chrome is
// known to sometimes blank out such referrers of tabs created during
// session restores or undo-closed-tabs
var CHROME_BLANKABLE_REFERRER_REGEXP = new RegExp(
    /^http.+google.+\/(search\?.*sugexp=chrome,mod=\d+\&sourceid=chrome|url\?.*source=web)/);


///////////////////////////////////////////////////////////
// Globals
///////////////////////////////////////////////////////////

var associationRuns = {};
var associationStubbornTabIds = {};
var associationConcurrentRuns = 0;
var associationGetDetailsRetryList = {};

///////////////////////////////////////////////////////////
// Association functions
///////////////////////////////////////////////////////////

// TODO deal with pages that are theoretically scriptable, yet fail to connect via ch.ext.connect
// Most common type is a page that 404'd on load.
// Solution: Accumulate a list of tabs that we have tried to do association for, and as we succeed
// in doing so remove them from the list.
// Each time we succeed in doing an association, record an lastAssociationSuccessTimestamp.
// In associatePagesCheck(), if the delta between now and lastAssociationSuccessTimestamp is more
// than N seconds, go through the list of tabs that we have not been able to associate yet and
// treat them in the way we treat nonscriptable tabs.
// If N=30 that means we won't try that tactic until 30 seconds pass between successfully associating
// any tab. 30 should be a sufficient amount of time for browser startup with 100 tabs, because
// the getPageDetails responses should be trickling in during this timeframe. However 30 seconds
// is a very long time to wait for a response for a given tab before finally doing fallback association.
// If we don't start checking this lastAssociationSuccessTimestamp delta until we get at least ONE
// association completed, then we should be able to make it more like N=10; thereafter, as long as
// we get one tab associated every 10 seconds, we won't mistakenly go and do the nonscriptable fallback
// technique on anybody erroneously.
//
// A more complex solution is to take the average of the time delta between the last N association-successes
// and use that to project into the future when we expect another association may still happen, with some
// amount of extra padding to compensate for variances when e.g. reddit is loading.
//
// Another possible approach is to do more of this work in onCommitted, e.g. whenever we see a 'reload'
// transitionType we should be trying to associate to a restorable (if no sessionGUID) or hibernated/recently-closed
// (if has sessionGUID) page.
//
// We might also be able to catch 404 type errors in webRequest event stream and act more quickly on those pages
// (treating them like nonscriptables) to associate them faster.
//
// This would then leave "uncommunicative" pages, like a 10-hour old isohunt.com page we saw, that refused
// to respond to executeContentScript(). But possibly we could treat that case as a fluke OR possibly using
// onConnect method will avoid the problem because port is already established and perhaps will still
// work when executeContentScript() no longer will.
//
// TODO keep running assocationRuns for some time, say 120 seconds, even after associatePagesCheck() finds
// nothing left to do, just in case we have a run that just happened to return nothing, but there could still
// be more that are slow to come up; this should probably be considered separate from a user doing a manual
// "reopen 15 closed tabs" from Chrome's deafult New Tab page since those will not happen upon session restore
// and should be adequately dealt with inside of onCommitted[transitionType=reload]->associateTabToPageNode()
// logic. However, during that 120 seconds, we should still expect that we will capture those tabs in a run
// of startAssociationRun() and thus we should make sure that having both onCommitted and startAssociationRun() firing
// associateTabToPageNode() doesn't fritz things out. A nice approach might be, when onCommitted sees
// a 'reload', if we think it might be an "associate to a restorable" case (sessionGUID not found in closed-tabs list
// or hibernated-tabs-in-tree), then just fire up an startAssociationRun() run and let it do all that work for us;
// this is probably a better solution because we can reuse more of the association code and logics; we will
// just need to take care to set the 120-second timer separately from onCommitted's firing of startAssociationRun().

// Main entry point for starting the association process.
// Tries to associate all existing tabs to a page row, and will
// repeatedly restart the process after a delay until all
// tabs have been associated with something.
function startAssociationRun() {
    if (associationConcurrentRuns > 0) {
        return;
    }

    fixBadNodes(); // fix pages stuck at root before doing association to improve association accuracy in this bad case

    chrome.tabs.query({ }, function(tabs) {
        if (associationConcurrentRuns > 0) {
            return;
        }

        var runId = generateGuid();
        var runInfo = { runId: runId, total: 0, count: 0, tabIds: [] };
        associationRuns[runId] = runInfo;
        associationConcurrentRuns++;
        log('Starting a new association run', 'runId', runId, 'runInfo', runInfo);

        for (var i in tabs) {
            var tab = tabs[i];
            if (sidebarHandler.tabId == tab.id || tab.url == chrome.extension.getURL('/sidebar.html')) {
                // this tab is the sidebar
                continue;
            }
            if (tree.getNode(['chromeId', tab.id])) {
                // this tab is already in the tree as a normal tab
                continue;
            }
            // log('trying association', 'runId', runId, 'tabId', tab.id, 'total', runInfo.total, 'count', runInfo.count);
            if (!tryAssociateTab(runInfo, tab)) {
                runInfo.total++;
            }

        }
        if (runInfo.total == 0) {
            log('No unassociated tabs left to associate; ending association run and doing parent window guessing');
            endAssociationRun(runId);
            // log(tree.dump());
            return;
        }
        log('Started association process, tabs in queue: ' + runInfo.total);
        TimeoutManager.reset(runId, function() { associatePagesCheck(runId); }, ASSOCIATE_PAGES_CHECK_INTERVAL_MS);
    });
}


///////////////////////////////////////////////////////////
// Helper functions used during assocation runs.
///////////////////////////////////////////////////////////

function endAssociationRun(runId) {
    var runInfo = associationRuns[runId];
    log('Ending association run', runId, runInfo);
    delete associationRuns[runId];
    associationConcurrentRuns--;

    tree.rebuildTabIndex();
    rectifyAssociations(CLEANUP_AFTER_ASSOCIATION_RUN_DELAY_MS);

    try {
        TimeoutManager.clear(runId);
    }
    catch(ex) {
        if (ex.message != 'A timeout with the given label does not exist') {
            throw ex;
        }
    }
}

// Returns true if tab was immediately associated or false if an asynchronous
// call to the page's content script was required to do potential association later
function tryAssociateTab(runInfo, tab, forceNewTabAssociation) {
    var runId = runInfo.runId;

    if (tab.incognito) {
        // Since incognito tabs are never saved to disk they cannot be reassociated
        // after loading the old tree from disk
        return false;
    }

    if (!forceNewTabAssociation && isNewTabUrl(tab.url) && tab.index == 0 && !tab.pinned) {
        chrome.tabs.query({ windowId: tab.windowId }, function(tabs) {
            if (tabs.length == 1) {
                // Never associate New Tab pages which are all by themselves in a window;
                // we'll just create new nodes for this
                tree.addTabToWindow(tab, new PageNode(tab));
                return;
            }
            // Allow us to do normal association for this New Tab node
            tryAssociateTab(runInfo, tab, true);
            return;
        });
        return false;
    }

    if (tryFastAssociateTab(tab, true)) {
        return true;
    }

    if (isNewTabUrl(tab.url)) {
        // Only permit trying fast association for New Tab pages to avoid improperly resurrecting
        // Last Session windows when starting Chrome with 'start with New Tab' option set
        tree.addTabToWindow(tab, new PageNode(tab));
        return true;
    }

    if (!isScriptableUrl(tab.url)) {
        // this tab will never be able to return details to us from content_script.js,
        // so just associate it without the benefit of those extra details
        log('Doing blind association for non scriptable tab', tab.id, tab.url);
        associateTabToPageNode(runId, tab);
        return true;
    }

    // record this tab's id in this run's tabIds list as one we expect to be restoring
    // in a later phase of this run
    runInfo.tabIds.push(tab.id);

    // ask the tab for more details via its content_script.js connected port
    if (!getPageDetails(tab.id, { action: 'associate', runId: runId })) {
        log('Port does not exist for association yet', 'tabId', tab.id, 'runId', runId);
    }
    return false;
}

function tryFastAssociateTab(tab, mustBeRestorable) {
    var existingWindow = tree.getNode(['chromeId', tab.windowId]);
    var inArray = (existingWindow ? existingWindow.children : undefined);
    var matches = tree.filter(function(e) {
        return e instanceof PageNode
            && e.hibernated
            && (!mustBeRestorable || e.restorable)
            && tab.url == e.url
            && tab.index == e.index
            && tab.incognito == e.incognito
            && tab.pinned == e.pinned;
    }, inArray);

    if (matches.length == 1 || (matches.length > 0 && !isScriptableUrl(tab.url))) {
        // Exactly one page node matches this tab by url+index so assume it's a match
        // and do the association
        var match = matches[0];
        log('doing fast associate', tab, match, tab.id, match.id, 'pinned states', tab.pinned.toString(), match.pinned.toString());
        restoreAssociatedPage(tab, match);

        // ask the tab for more details via its content_script.js connected port
        // in this case we only need them to store on the node in case a successive
        // assocation run fails to do fast association
        if (isScriptableUrl(tab.url)) {
            getPageDetails(tab.id, { action: 'store' });
        }
        return match;
    }
    return undefined;
}

function tryAssociateExistingToRestorablePageNode(existingPage) {
    var tabId = existingPage.chromeId;

    if (!tabId) {
        console.error('tabId not available for provided existingPage', existingPage.id, existingPage);
        return;
    }

    // ask the tab for more details via its content_script.js connected port
    if (!getPageDetails(tabId, { action: 'associate_existing' })) {
        var existingPageId = existingPage.id;
        existingPage = tree.getNode(existingPageId);

        if (!existingPage) {
            log('Page no longer exists to get page details from', existingPageId);
            return;
        }

        var tries = associationGetDetailsRetryList[tabId] || 0;

        if (tries >= ASSOCIATE_GET_DETAILS_MAX_RETRIES) {
            console.error('Exceeded max retries for getting page details', tabId, existingPage);
            delete associationGetDetailsRetryList[tabId];
            return;
        }

        log('Port does not exist for existing-to-restorable association yet, retrying shortly', 'tabId', tabId, 'existing page', existingPage);
        associationGetDetailsRetryList[tabId] = tries + 1;
        setTimeout(function() {
            tryAssociateExistingToRestorablePageNode(existingPage);
        }, ASSOCIATE_GET_DETAILS_RETRY_WAIT_MS);
        return;
    }
    delete associationGetDetailsRetryList[tabId];
}

function associateExistingToRestorablePageNode(tab, referrer, historylength, sessionGuid) {
    var tabId = tab.id;
    var existingPage = tree.getNode(['chromeId', tabId]);

    log('associating existing to restorable', 'tabId', tabId, 'existing', existingPage, 'referrer', referrer,
        'historylength', historylength);

    // try restoring by sessionGuid match vs. rctree first
    if (sessionGuid) {
        var rcNode = recentlyClosedTree.getNode(['sessionGuid', sessionGuid]);
        if (rcNode) {
            moveReopenedNode(existingPage, rcNode);
            return;
        }
    }

    var match = findPageNodeForAssociation({
        mustBeHibernated: true,
        mustBeRestorable: true,
        url: tab.url,
        referrer: referrer,
        historylength: historylength,
        pinned: tab.pinned,
        incognito: tab.incognito
    });

    if (!match) {
        log('No restorable match found');
        return;
    }

    log('Restorable match found', 'match', match, 'match.id', match.id);

    tree.mergeNodes(existingPage, match);
    restoreAssociatedPage(tab, match);

    if (referrer !== undefined) {
        match.referrer = referrer;
    }
    if (historylength !== undefined) {
        match.historylength = historylength;
    }

    // TODO call cleanup only iff all existing restorable windows
    // have zero .restorable children (and there is at least one such restorable window
    // still left to try and restore) ??
    rectifyAssociations(CLEANUP_AFTER_ASSOCIATE_EXISTING_PAGE_DELAY_MS);
}

// Run a series of association, disambiguation, and guarantee steps to get the tree as accurate as possible when
// there are ambiguous tab-to-page mappings, window nodes with no children, improperly ordered tabs on Chrome's tabbar, etc.
function rectifyAssociations(delay) {
    TimeoutManager.reset('rectifyAssociations', function() {
        tree.rebuildPageNodeWindowIds(function() {                                  // obtain fresh tab windowIds and indexes
            associateWindowstoWindowNodes(true, false, function() {                 // associate OR merge windows, stringent match
                disambiguatePageNodesByWindowId();                                  // disambiguate tabs
                associateWindowstoWindowNodes(true, true, function() {              // associate windows, stringent match
                    disambiguatePageNodesByWindowId();                              // disambiguate tabs
                    associateWindowstoWindowNodes(false, true, function() {         // associate windows, relaxed match
                        disambiguatePageNodesByWindowId();                          // disambiguate tabs
                        associateWindowstoWindowNodes(false, false, function() {    // associate OR merge windows, relaxed match
                            disambiguatePageNodesByWindowId();                      // move pages to be under correct window node based on .windowId
                            movePageNodesToCorrectWindows(function() {              // ensure no page node is located under an incorrect (mismatched) window node
                                fixBadNodes();                                      // fix nodes being at a level of the tree they aren't permitted at
                                removeZeroChildWindowNodes();                       // get rid of any zero-child window nodes stuck in the tree
                                tree.rebuildPageNodeWindowIds(function() {          // sanity guarantee
                                    tree.rebuildTabIndex();                         // sanity guarantee
                                    tree.rebuildIndexes();                          // sanity guarantee
                                    tree.rebuildParents();                          // sanity guarantee
                                    fixAllPinnedUnpinnedTabOrder();                 // correct ordering of pinned vs. unpinned tabs in the tree/tab order
                                    swapPageNodesByIndex();
                                    tree.conformAllChromeTabIndexes(true);          // conform chrome's tab order to match the tree's order
                                    tree.conformAllChromeTabIndexes(false);         // conform chrome's tab order to match the tree's order again after standard delay
                                    removeOldWindows();                            // get rid of old 'Last Session' windows

									// make a backup if we don't have one yet
                                    var backup = settings.get('backupPageTree', []);
                                    if (!backup || backup.length == 0) {
                                        backupPageTree(true);
                                    }

                                    log('Rectification complete');
                                });
                            });
                        });
                    });
                });
            });
        });
    }, delay || 1);
}

function associatePagesCheck(runId) {
    var runInfo = associationRuns[runId];

    if (!runInfo) {
        log('Association run is already ended', runId);
        // associateWindowstoWindowNodes();
        // log('Starting a slow tick loop of startAssociationRun');
        // setInterval(startAssociationRun, ASSOCIATE_PAGES_CHECK_INTERVAL_MS_SLOW);
        return;
    }

    log('associatePagesCheck', 'total', runInfo.total, 'count', runInfo.count, 'tabIds', runInfo.tabIds);

    log('stubborn tabs list before update', JSON.stringify(associationStubbornTabIds));

    for (var i in runInfo.tabIds) {
        var tabId = runInfo.tabIds[i];
        var count = (associationStubbornTabIds[tabId] || 0) + 1;

        if (count >= ASSOCIATE_STUBBORN_TAB_FALLBACK_THRESHOLD_ITERATIONS) {
            // this tab is being too stubborn and will not respond to getPageDetails() attempts,
            // so just fallback to the simpler method of url matching
            chrome.tabs.get(tabId, function(tab) {
                log('Using fallback association for stubborn tab', 'tabId', tab.id, 'runId', runId);
                associateTabToPageNode(runId, tab);
            });
        }
        else {
            associationStubbornTabIds[tabId] = count;
        }
    }

    log('stubborn tabs list after update', JSON.stringify(associationStubbornTabIds));

    endAssociationRun(runId);

    startAssociationRun();
}

function associateTabToPageNode(runId, tab, referrer, historylength) {
    log('Associating tab', 'runId', runId, 'tabId', tab.id, 'url', tab.url, 'referrer', referrer, 'historylength', historylength, 'associationRuns', associationRuns);

    var runInfo = associationRuns[runId];

    // Is this run still in progress?
    if (runInfo) {
        // Remove this tab from the list of tabs still to be processed in this run
        runInfo.tabIds.splice(runInfo.tabIds.indexOf(tab.id), 0);

        // Reset the associatePagesCheck timeout for this run
        TimeoutManager.reset(runId, function() { associatePagesCheck(runId) }, ASSOCIATE_PAGES_CHECK_INTERVAL_MS);

        // Increment number of tabs that have been associated this run
        runInfo.count++;
    }

    var existingPage = tree.getNode(['chromeId', tab.id]);

    if (existingPage) {
        // tab is already properly present as a pagenode in the tree and we don't want to
        // merge it into a restorable pagenode
        return;
    }

    var match = findPageNodeForAssociation({
        mustBeHibernated: true,
        mustBeRestorable: true,
        topParentMustBeRealOrRestorableWindow: true,
        url: tab.url,
        referrer: referrer,
        historylength: historylength,
        pinned: tab.pinned,
        incognito: tab.incognito
    });

    if (!match) {
        // apparently a new tab to us
        log('no matching PageNode found, adding to a new window', tab.id, tab);
        tree.addTabToWindow(tab, undefined, function(page, win) {
            tree.updateNode(page, { referrer: referrer || '', historylength: historylength || 1 });

            // set focus to this page if it and its window have the current focus
            if (tab.active && focusTracker.getFocused() == tab.windowId) {
                tree.focusPage(tab.id);
            }
        });
        return;
    }

    log('matching PageNode found, restoring', tab.id, tab, 'match', match.id, match, 'pinned states', tab.pinned.toString(), match.pinned.toString());
    restoreAssociatedPage(tab, match);
}

function restoreAssociatedPage(tab, page) {
    log('restoring associated page', 'tab', tab.id, tab, 'page', page.id, page, tab.url, page.url);
    var details = {
        restored: true,
        hibernated: false,
        restorable: false,
        chromeId: tab.id,
        windowId: tab.windowId,
        index: tab.index,
        pinned: tab.pinned
    };
    tree.updateNode(page, details);

    // get updated status from Chrome in a moment
    chrome.tabs.get(tab.id, function(t) {
        tree.updateNode(page, { status: t.status });
    });

    // set focus to this page if it and its window have the current focus
    if (tab.active && focusTracker.getFocused() == tab.windowId) {
        tree.focusPage(tab.id);
    }

    var topParent = page.topParent();
    restoreParentWindowViaUniqueChildPageNode(topParent, page, tab.windowId);

    // check and fix pinned-vs-unpinned tab order after restoration
    fixPinnedUnpinnedTabOrder(page);
    return page;
}

function restoreParentWindowViaUniqueChildPageNode(parentWindowNode, childPageNode, childWindowId)
{
    // When node is under a hibernated window node, we want to see if this tab/node has
    // a unique key amongst all nodes. If so, we know that this tab's .windowId
    // can definitively identify the parent hibernated window's new windowId.
    if (!(parentWindowNode instanceof WindowNode) || !parentWindowNode.hibernated) {
        return;
    }

    // parentWindowNode is a restorable window node.
    // Is there any other page node in the tree with the same constructed key
    // as childPageNode?
    var otherMatch = findPageNodeForAssociation({
        url: childPageNode.url,
        title: childPageNode.title,
        referrer: childPageNode.referrer,
        historylength: childPageNode.historylength,
        notMatchingNode: childPageNode,
        pinned: childPageNode.pinned,
        incognito: childPageNode.incognito
    });

    if (otherMatch) {
        // childPageNode's constructed key is not unique, cannot use it
        // to establish parent window's new windowId
        return;
    }

    // Node's key is unique, so we can use this tab's .windowId to set
    // the restorable parent window node's proper windowId.

    // does a WindowNode already exist matching the tab's .windowId?
    var existingWinNode = tree.getNode(['chromeId', childWindowId]);
    if (existingWinNode) {
        // already exists, so merge its children into our restorable window
        tree.mergeNodes(existingWinNode, parentWindowNode);
    }

    // Restore the restorable parent window and assign it tab's .windowId
    tree.updateNode(parentWindowNode, {
        restorable: false,
        hibernated: false,
        chromeId: childWindowId,
        title: WINDOW_DEFAULT_TITLE
    });
    tree.expandNode(parentWindowNode);
}

function findPageNodeForAssociation(params, findAll) {
    var fallbackReferrer = params.referrer;
    if (params.referrer && CHROME_BLANKABLE_REFERRER_REGEXP.test(params.referrer)) {
        fallbackReferrer = '';
    }

    var testUrl = params.url;
    var matchingGoogleUrl = false;

    if (isGoogleSearchUrl(testUrl)) {
        // special handling for google urls, which seem to tack on &sei= query parameters
        // that vary between restarts
        matchingGoogleUrl = true;
        var googleTestUrl = getGoogleTestUrl(testUrl);
    }

    if (findAll) {
        return tree.filter(testNodeForAssociation);
    }
    return tree.getNode(testNodeForAssociation);

    function testNodeForAssociation(node) {
        if (!(node instanceof PageNode)) {
            return false;
        }

        var urlMatch = false;
        if (!matchingGoogleUrl) {
            urlMatch = (testUrl == node.url);
        }
        else {
            if (!isGoogleSearchUrl(node.url)) {
                return false;
            }
            // special handling for google urls, which seem to tack on &sei= and/or #hash.. components to the url
            // which are known to vary between restarts for the same tab
            var googleNodeUrl = getGoogleTestUrl(node.url);
            urlMatch = (googleNodeUrl == googleTestUrl);
        }

        var matched = (!params.mustBeHibernated || node.hibernated === true)
            && (!params.mustBeRestorable || node.restorable === true)
            && urlMatch
            && (!params.title || node.title == params.title)
            && (params.incognito === undefined || node.incognito == params.incognito)
            && (params.pinned === undefined || node.pinned == params.pinned)
            && (params.historylength === undefined || node.historylength == params.historylength)
            && (params.notMatchingNode === undefined || node !== params.notMatchingNode);

        if (!matched) {
            return false;
        }


        if (params.topParentMustBeRealOrRestorableWindow) {
            var topParent = node.topParent();
            if (!(topParent instanceof WindowNode)) {
                return false;
            }

            if (topParent.restorable == false && topParent.hibernated == true) {
                return false;
            }
        }

        if (params.referrer === undefined || params.referrer == node.referrer) {
            return true;
        }

        if (params.pinned && node.pinned) {
            // for pinned tabs, Chrome blanks out the referrer if 'Open pages from last time'
            // setting is not on; since we cannot determine if that setting is on, we just
            // match on pinned state and ignore referrer matching entirely for these
            return true;
        }

        // Chrome sometimes blanks out certain referrers after a browser restart;
        // for such referrers we will count a node as matching if either the existing
        // node's referrer or the passed referrer match parameter are blank
        var fallbackNodeReferrer = node.referrer;
        if (node.referrer && CHROME_BLANKABLE_REFERRER_REGEXP.test(node.referrer)) {
            fallbackNodeReferrer = '';
        }

        if (fallbackReferrer == fallbackNodeReferrer) {
            return true;
        }

        return false;
    }
}


function isGoogleSearchUrl(url) {
    return url.match(/^https?:\/\/.*google.*\/search\?q=/);
}

function getGoogleTestUrl(url) {
    var r = url.replace(/sei=[a-zA-Z0-9]+/g, '').replace(/\#.+$/, '');
    return r;
}

function associateWindowstoWindowNodes(requireChildrenCountMatch, prohibitMergingWindows, onComplete) {
    var wins = tree.filter(function(e) {
        return e.elemType == 'window' && e.restorable == true;
    });

    if (wins.length == 0) {
        if (onComplete) onComplete();
        return;
    }

    log('Restorable window set ids', wins.map(function(e) { return e.id; }));

    chrome.tabs.query({ }, function(tabs) {
        var windowTabCounts = {};
        for (var i = tabs.length - 1; i >= 0; i--) {
            windowTabCounts[tabs[i].windowId] = (windowTabCounts[tabs[i].windowId] || 0) + 1;
        }

        var counts = {};
        var winNodePageCounts = {};

        for (var i = wins.length - 1; i >= 0; i--) {
            var win = wins[i];
            var groups = tree.reduce(function(last, e) {
                if (!e.isTab()) return last;
                var tabId = e.chromeId;
                var tab = first(tabs, function(e) { return e.id == tabId; })[1];
                var windowId = tab.windowId;

                if (e.pinned != tab.pinned || e.incognito != tab.incognito) {
                    return last;
                }

                winNodePageCounts[win.id] = (winNodePageCounts[win.id] || 0) + 1;
                last[windowId] = (last[windowId] || 0.0) + 1.0 + (e.index == tab.index ? 0.00001 : 0);
                return last;
            }, {}, win.children);
            for (var g in groups) {
                var count = groups[g].toString();
                if (counts[count]) {
                    counts[count].push([win, g]);
                    continue;
                }
                counts[count] = [[win, g]];
            }
        }
        log('Window association counts, window node vs. descendant tabs with matching .windowId', counts);
        log('Window association counts, tabs per Chrome window', windowTabCounts);
        log('Window association counts, total tabs per window node', winNodePageCounts);

        var countValues = [];
        for (var count in counts) {
            countValues.push(parseFloat(count));
        }
        countValues.sort();

        var usedWindowIds = [];
        var usedWindowNodes = [];
        for (var i = countValues.length - 1; i >= 0; i--) {
            var countValue = countValues[i];
            var countSet = counts[countValue.toString()];
            for (var j = countSet.length - 1; j >= 0; j--) {
                var pair = countSet[j];
                var win = pair[0];
                var windowId = parseInt(pair[1]);

                if (usedWindowIds.indexOf(windowId) >= 0 || usedWindowNodes.indexOf(win) >= 0) {
                    // this windowid or window node has already been associated this run, with a higher-scoring
                    // windowid/node pairing than this
                    log('Skipping win-to-node match because windowId or node has already been restored', win.id, windowId);
                    continue;
                }

                if (requireChildrenCountMatch && winNodePageCounts[win.id] != windowTabCounts[windowId]) {
                    log('Skipping win-to-node match due to differing wake tab child counts', win.id, windowId, 'counts', winNodePageCounts[win.id], windowTabCounts[windowId]);
                    continue;
                }

                // does a WindowNode already exist matching this windowId?
                var existingWinNode = tree.getNode(['chromeId', windowId]);
                if (existingWinNode) {
                    if (!prohibitMergingWindows) {
                        // already exists, so merge its children into our restorable window
                        log('Merging windows', existingWinNode.id, win.id);
                        mergeWindowsPreservingTabIndexes(existingWinNode, win);
                        tree.mergeNodes(existingWinNode, win);
                    }
                    else {
                        // that is not allowed
                        log('Merging windows not allowed, though we did find an existing node with this window id already in existence', existingWinNode.id, win.id);
                        continue;
                    }
                }

                // update the restore window to look like the real window
                log('Restoring window node', win.id, 'as window id', windowId);
                var details = {
                    restorable: false,
                    hibernated: false,
                    chromeId: windowId,
                    title: WINDOW_DEFAULT_TITLE
                };
                tree.updateNode(win, details);
                tree.expandNode(win);

                usedWindowIds.push(windowId);
                usedWindowNodes.push(win);
            }
        }
        if (onComplete) onComplete();
    });
    return;
}

// When multiple page nodes have identical matching-keys during an association run, sometimes such a node
// will get put into the tree under what eventually becomes the incorrect window node. Here we identify such
// sets of matching-key nodes and swap their ids around to make things correct
// Set iterations to the maximum number of times the function should re-call itself after completing, which it does
//    only when there was at least one swap performed in this run; our logic sometimes does not get everything
//    100% correct in the first round; defaults to 3 when undefined
function disambiguatePageNodesByWindowId(iterations) {
    var swapCount = 0;

    if (iterations === undefined) iterations = 3;

    // find all matching-key groups, removing those page nodes whose windowId already matches its parent window.id
    var groups = tree.groupBy(function(e) {
        if (!e.isTab()) {
            return undefined;
        }
        var topParent = e.topParent();
        var topParentChromeId = topParent.chromeId;
        if (!topParent) {
            return undefined;
        }
        if (e.windowId == topParentChromeId) {
            return undefined;
        }
        var key = [e.url, e.referrer, e.historylength, e.pinned, e.incognito].join('|');
        return key;
    });
    for (var g in groups) {
        var items = groups[g];
        // console.log(g, items);
        if (items.length < 2) {
            continue;
        }
        for (var i = 0; i < items.length; i++) {
            var item = items[(i + iterations) % items.length];
            var topParentId = item.topParent().id;
            var topParentChromeId = item.topParent().chromeId;
            if (item.windowId == topParentChromeId) {
                // already under the correct parent window node
                // console.log('already under correct parent', item.windowId, topParentId);
                continue;
            }

            swapCount++;

            // In order of preference:
            var swapWith;
            // swap with a same-key node whose .windowId and topParent.id are transpositions of our working node's and .index values match
            swapWith = items.filter(function(e) { return e !== item && e.windowId == topParentChromeId && item.windowId == e.topParent().chromeId && e.index == item.index; });
            if (swapWith.length == 0) {
                // swap with a same-key node whose .windowId and topParent.id are transpositions of our working node's
                swapWith = items.filter(function(e) { return e !== item && e.windowId == topParentChromeId && item.windowId == e.topParent().chromeId; });
                if (swapWith.length == 0) {
                    // swap with a same-key node whose topParent.id matches our working node's .windowId (we need to be in that window)
                    swapWith = items.filter(function(e) { return e !== item && item.windowId == e.topParent().chromeId; });
                    if (swapWith.length == 0) {
                        swapWith = items.filter(function(e) { return e !== item && e.windowId == topParentChromeId; });
                        if (swapWith.length == 0) {
                            // node is in the wrong window but there is nobody to swap with in that window with the same key;
                            // this should never happen and if it does we need to track down what caused that to occur
                            log('Disambiguation missed:', swapCount, g, i, item);
                            continue;
                        }
                    }
                }
            }
            log('Swapping for disambiguation:', swapCount, 'page ids', item.id, swapWith[0].id, '.windowIds', item.windowId, swapWith[0].windowId, 'topParentIds', item.topParent().id, swapWith[0].topParent().id, 'group', g, items);

            var temp = item.chromeId;
            tree.updateNode(item, { chromeId: swapWith[0].chromeId });
            tree.updateNode(swapWith[0], { chromeId: temp });

            var temp = item.windowId;
            tree.updateNode(item, { windowId: swapWith[0].windowId });
            tree.updateNode(swapWith[0], { windowId: temp });

            var temp = item.index;
            tree.updateNode(item, { index: swapWith[0].index });
            tree.updateNode(swapWith[0], { index: temp });

            log('After swap, primary windowid matchup is', item.windowId, item.topParent().chromeId);
            var swappee = tree.getNode(swapWith[0].id);
            log('After swap, secondary windowid matchup is', swappee.windowId, swappee.topParent().chromeId);

            // break;
        }
    }
    if (swapCount > 0 && iterations > 1) {
        // log('- Verifying disambiguation -');
        disambiguatePageNodesByWindowId(iterations - 1);
        return;
    }
    // log('Disambiguation complete');
}

function swapPageNodesByIndex() {
    // find all matching-key groups we might want to swap around
    var groups = tree.groupBy(function(e) {
        if (!e.isTab()) {
            return undefined;
        }
        var topParent = e.topParent();
        if (!topParent) {
            return undefined;
        }
        var key = [topParent.id, e.url, e.referrer, e.historylength, e.pinned, e.incognito].join('|');
        return key;
    });
    for (var g in groups) {
        var items = groups[g];
        // console.log(g, items);
        if (items.length < 2) {
            continue;
        }
        for (var i = 0; i < items.length; i++) {
            var item = items[i];

            if (item.index == tree.getTabIndex(item)) {
                continue;
            }

            var swapWith = items.filter(function(e) { return tree.getTabIndex(e) == item.index; });
            if (swapWith.length > 0) {
                log('Swapping for index correction:', 'page ids', item.id, swapWith[0].id, 'indexes', item.index, swapWith[0].index);
                var temp = item.index;
                tree.updateNode(item, { index: swapWith[0].index });
                tree.updateNode(swapWith[0], { index: temp });

                var temp = item.chromeId;
                tree.updateNode(item, { chromeId: swapWith[0].chromeId });
                tree.updateNode(swapWith[0], { chromeId: temp });
            }
        }
    }
}

function movePageNodesToCorrectWindows(onComplete) {
    tree.rebuildPageNodeWindowIds(function() {
        chrome.tabs.query({ }, function(tabs) {
            tabs.forEach(function(tab) {
                if (tab.url == chrome.extension.getURL('/sidebar.html')) {
                    return;
                }

                var page = tree.getNode(['chromeId', tab.id]);

                if (!page) {
                    console.error('Page with this open tab\'s id does not exist in tree', tab.id, tab);
                    return;
                }

                var topParent = page.topParent();
                if (!(topParent instanceof WindowNode && !topParent.isRoot) || topParent.hibernated) {
                    return;
                }
                var topParentChromeId = topParent.chromeId;
                if (topParentChromeId == tab.windowId) {
                    return;
                }

                log('Page node is under wrong window node, moving it', tab.id, page.id, tab, page);

                // look for a page that (according to Chrome) has the next .index in that window
                var nextByIndex = tree.getNode(function(e) {
                    return e.isTab() && e.windowId == tab.windowId && e.topParent().chromeId == tab.windowId && e.index == tab.index + 1;
                });
                if (nextByIndex) {
                    log('Moving', page.id, 'before', nextByIndex);
                    tree.moveNodeRel(page, 'before', nextByIndex);
                    return;
                }

                // look for a page that (according to Chrome) has the previous .index in that window
                var prevByIndex = tree.getNode(function(e) {
                    return e.isTab() && e.windowId == tab.windowId && e.topParent().chromeId == tab.windowId && e.index == tab.index - 1;
                });
                if (prevByIndex) {
                    log('Moving', page.id, 'after', prevByIndex);
                    tree.moveNodeRel(page, 'after', prevByIndex);
                    return;
                }

                // just add the this tab to the (possibly new) window node with this index
                log('Moving', page.id, 'to possibly-new window node', tab.windowId);
                tree.addTabToWindow(tab, page);
                return;

            });

            if (onComplete) onComplete();
        });
    });
}

function fixBadNodes() {
    // if a page/folder node got stuck at the root of the tree, fix this
    var baddies = tree.root.children.filter(function(e) { return !(e instanceof WindowNode); });
    for (var i = baddies.length - 1; i >= 0; i--) {
        var baddy = baddies[i];
        var winNode = baddy.preceding(function(e) { return e instanceof WindowNode && e.type != 'popup'; });
        if (!winNode) {
            winNode = baddy.following(function(e) { return e instanceof WindowNode && e.type != 'popup'; });
        }
        if (!winNode) {
            log('No window to put bad node into! Creating one...', baddy.id, baddy);
            winNode = new WindowNode({ id: baddy.windowId, incognito: baddy.incognito, type: 'normal' });
            tree.addNode(winNode);
        }
        log('Fixing bad page node', baddy.id, baddy, 'appending as child to', winNode.id);
        tree.moveNodeRel(baddy, 'append', winNode, true);
    }

    // if a window node is not at the root, fix this
    baddies = tree.filter(function(e) { return e instanceof WindowNode && (e.parent && !e.parent.isRoot); });
    var movedWindow = false;
    for (var i = baddies.length - 1; i >= 0; i--) {
        var baddy = baddies[i];
        log('Fixing bad window node', baddy.id, baddy, 'appending to root');
        tree.moveNodeRel(baddy, 'append', tree.root, true);
        movedWindow = true;
    }
    if (movedWindow) {
        movePageNodesToCorrectWindows();
    }
}

function removeZeroChildWindowNodes() {
    // if a window node has no children, remove it
    var baddies = tree.filter(function(e) { return e instanceof WindowNode && e.children.length == 0; });
    var removedWindow = false;
    for (var i = baddies.length - 1; i >= 0; i--) {
        var baddy = baddies[i];
        log('Removing zero-child bad window node', baddy.id, baddy);
        tree.removeNode(baddy);
        removedWindow = true;
    }
    if (removedWindow && sidebarHandler.sidebarExists()) {
        // Reload sidebar if the removed window node(s) had a duplicate ID of another
        // window node; sidebar's method of accessing rows by id does not work in this case and
        // visually corrupts the tree. Redrawing the sidebar tree circumvents this uncommon case.
        var needReload = false;
        var duplicates = baddies.map(function(e) { return e.id; });
        duplicates.sort();
        var last = duplicates[0];
        for (var i = 1; i < duplicates.length; i++) {
            if (duplicates[i] == last) {
                try {
                    setTimeout(function() {
                        sidebarHandler.sidebarPanes['pages'].location.reload();
                    }, 500);
                }
                catch(ex) { }
                break;
            }
            last = duplicates[i];
        }
    }
}

function removeOldWindows() {
    var rememberOpenPages = settings.get('rememberOpenPagesBetweenSessions');

    var youngWindows = tree.root.children.filter(function(e) {
        return e instanceof WindowNode
            && e.hibernated
            && e.restorable
            && !e.old;
    });

    var oldWindows = tree.root.children.filter(function(e) {
        return e instanceof WindowNode && e.old;
    });

    oldWindows.forEach(function(e) {
        if (e.hibernated && (!rememberOpenPages || youngWindows.length > 0)) {
            // old window that is still hibernated - remove to rctree
            tree.removeNode(e, true);
            return;
        }
        // old window that is not hibernated, or there are no younger Last Session
        // windows found
        tree.updateNode(e, { old: false });
    });
}

function mergeWindowsPreservingTabIndexes(fromWindow, toWindow) {
    var incoming = tree.filter(function(e) { return true; }, fromWindow.children);
    var existing = tree.filter(function(e) { return true; }, toWindow.children);
    var insertPosition;

    for (var i = incoming.length - 1; i >= 0; i--) {
        var node = incoming[i];

        if (!node.isTab()) {
            if (insertPosition) {
                tree.moveNodeRel(node, 'after', insertPosition);
                insertPosition = node;
                continue;
            }
            tree.moveNodeRel(node, 'prepend', toWindow);
            insertPosition = node;
            continue;
        }

        if (node.index == 0) {
            if (insertPosition) {
                tree.moveNodeRel(node, 'after', insertPosition);
                insertPosition = node;
                continue;
            }
            tree.moveNodeRel(node, 'prepend', toWindow);
            insertPosition = node;
            continue;
        }

        var following = firstElem(existing, function(e) {
            return e.isTab() && e.index == node.index + 1;
        });
        if (following) {
            tree.moveNodeRel(node, 'before', following);
            insertPosition = node;
            continue;
        }

        var preceding = firstElem(existing, function(e) {
            return e.isTab() && e.index == node.index - 1;
        });
        if (preceding) {
            if (preceding.children.length > 0) {
                tree.moveNodeRel(node, 'prepend', preceding);
                continue;
            }
            tree.moveNodeRel(node, 'after', preceding);
            insertPosition = node;
            continue;
        }

        console.warn('Did not find preceding node by index during win merging');
        tree.moveNodeRel(node, 'append', toWindow);
    }
}

