/*
    LiveG Open Search Index

    Copyright (C) LiveG. All Rights Reserved.

    https://search.liveg.tech
    Licensed by the LiveG Open-Source Licence, which can be found at LICENCE.md.
*/

const fs = require("fs");
const path = require("path");
const mkdirp = require("mkdirp");
const jsdom = require("jsdom");

const validLangs = require("./validlangs");

const fetch = function(...args) {
    return import("node-fetch").then(function({default: fetch}) {
        return fetch(...args);
    });
}

const MAX_CRAWL_ADDITIONS_PER_HOST = 5;
const MAX_SELECT_TOP_TO_CRAWL = 100;
const MIN_WORD_COUNT_AS_KEYWORD = 3;
const CRAWL_TIMEOUT_DURATION = 5 * 1_000; // 5 seconds
const CRAWL_PAUSE_DURATION = 3 * 1_000; // 3 seconds
const PAGE_RECRAWL_WAIT_DURATION = 7 * 24 * 60 * 60 * 1_000; // 1 week

const RE_MATCH_ALL_WORDS = /[\w']+/g;

const INDEX_FIELDS = ["url", "title", "description", "language", "firstIndexed", "lastUpdated", "referenceScore", "keywordScore"];
const CRAWLED_LIST_FIELDS = ["url", "firstIndexed", "lastUpdated", "timesCrawled"];

var pagesToCrawl = fs.readFileSync("data/tocrawl.txt", "utf-8").split("\n").filter((line) => line != "");
var pagesCrawled = {};
var crawlStats = {added: 0, crawled: 0, skipped: 0};
var indexes = {};

function normaliseWord(word) {
    return word.toLocaleLowerCase().replace(/[']/g, "");
}

function findCommonWords(text) {
    var words = {};

    [...text.matchAll(RE_MATCH_ALL_WORDS)].forEach(function(match) {
        var word = normaliseWord(match[0]);

        words[word] ||= 0;
        words[word]++;
    });
    
    return words;
}

function tsvToObjects(data) {
    if (data.trim() == "") {
        return [];
    }

    var entries = data.split("\n").filter((entry) => entry != "");
    var fields = entries.shift().split("\t");

    return entries.map(function(entryText) {
        var entry = {};

        entryText = entryText.split("\t");

        fields.forEach(function(field, i) {
            entry[field] = entryText[i];
        });

        return entry;
    });
}

function objectsToTsv(data, fields) {
    var entryLines = [];

    entryLines.push(fields.join("\t"));

    data.forEach(function(entry) {
        var entryLine = [];

        fields.forEach(function(field) {
            entryLine.push(entry[field]);
        });

        entryLines.push(entryLine.join("\t"));
    });

    return entryLines.join("\n");
}

function objectToArray(object, key) {
    return Object.keys(object).map((keyValue) => ({...object[keyValue], [key]: keyValue}));
}

function arrayToObject(array, key) {
    var object = {};

    array.forEach(function(item) {
        var keyValue = item[key];

        delete item[key];

        object[keyValue] = item;
    });

    return object;
}

function loadIndex(keyword) {
    var filePath = path.join("data", "indexes", `${keyword}.tsv`);

    if (!fs.existsSync(filePath)) {
        indexes[keyword] = [];

        return;
    }

    indexes[keyword] = tsvToObjects(fs.readFileSync(filePath, "utf-8"));
}

function saveIndex(keyword) {
    var filePath = path.join("data", "indexes", `${keyword}.tsv`);

    mkdirp.sync(path.join("data", "indexes"));

    fs.writeFileSync(filePath, objectsToTsv(indexes[keyword], INDEX_FIELDS));
}

function saveCrawlLists() {
    fs.writeFileSync("data/tocrawl.txt", pagesToCrawl.join("\n"));

    fs.writeFileSync("data/crawled.tsv", objectsToTsv(objectToArray(pagesCrawled, "url"), CRAWLED_LIST_FIELDS));
}

function crawlPage(url) {
    if (pagesCrawled.hasOwnProperty(url)) {
        if (Date.now() - pagesCrawled[url].lastUpdated < PAGE_RECRAWL_WAIT_DURATION) {
            console.log(`Already crawled within re-crawl wait duration: ${url}`);

            crawlStats.skipped++;

            return Promise.resolve();
        }
    }

    console.log(`Crawling: ${url}`);

    pagesCrawled[url] ||= {};
    pagesCrawled[url].firstIndexed ||= Date.now();
    pagesCrawled[url].lastUpdated = Date.now();

    pagesCrawled[url].timesCrawled ||= 0;
    pagesCrawled[url].timesCrawled++;

    saveCrawlLists();

    var controller = new AbortController();
    var signal = controller.signal;

    setTimeout(function() {
        controller.abort();
    }, CRAWL_TIMEOUT_DURATION);

    return fetch(url, {signal}).then(function(response) {
        if (response.status != 200) {
            console.log(`Non-200 skip: ${url}`);

            crawlStats.skipped++;

            return Promise.resolve();
        }

        return response.text().then(function(data) {
            var dom = new jsdom.JSDOM(data).window.document;

            dom.querySelectorAll("script, style, button, input, select, label").forEach((element) => element.remove());

            var pageTitle = dom.querySelector("title")?.textContent.trim();
            var pageDescription = (dom.querySelector("meta[name='description']")?.getAttribute("content") || "").trim();
            var pageText = dom.querySelector("body")?.textContent;
            var pageLanguage = dom.querySelector("html").getAttribute("lang")?.trim().split(/[-_]/)[0].toLocaleLowerCase() || "";

            pageLanguage = validLangs.REPLACE_LANGS[pageLanguage] || pageLanguage;

            if (!validLangs.VALID_LANGS.includes(pageLanguage)) {
                pageLanguage = "";
            }

            if (!pageTitle || !pageText) {
                console.log(`No text data skip: ${url}`);

                crawlStats.skipped++;

                return Promise.resolve();
            }

            var titleWords = [...pageTitle.matchAll(RE_MATCH_ALL_WORDS)].map((match) => normaliseWord(match[0]));
            var commonWords = findCommonWords(pageText);
            var wordSet = new Set([...titleWords, ...Object.keys(commonWords)]);

            wordSet.forEach(function(word) {
                var entry = {
                    url,
                    title: pageTitle.replace(/[\n\t]/g, ""),
                    description: pageDescription.replace(/[\n\t]/g, ""),
                    language: pageLanguage,
                    firstIndexed: Date.now(),
                    lastUpdated: Date.now(),
                    referenceScore: 1 / 100,
                    keywordScore: Math.min(((commonWords[word] || 0) + (titleWords.includes(word) ? 5 : 0)) / 25, 1)
                };

                if (word.match(/\d{1,3}/)) {
                    return;
                }

                if (entry.keywordScore < MIN_WORD_COUNT_AS_KEYWORD / 25) {
                    return;
                }

                if (!indexes[word]) {
                    loadIndex(word);
                }

                var currentEntry;

                if (currentEntry = indexes[word].find((currentEntry) => currentEntry.url == entry.url)) {
                    entry.firstIndexed = currentEntry.firstIndexed;
                    entry.referenceScore = Math.min(Number(currentEntry.referenceScore) + (1 / 100), 1);

                    Object.assign(currentEntry, entry);
                } else {
                    indexes[word].push(entry);
                }

                saveIndex(word);
            });

            var additionsPerHost = {};

            [...dom.querySelectorAll("a[href]")].forEach(function(element, i) {
                var reference = element.getAttribute("href");
                var newUrl = new URL(reference, url).href.split("#")[0].replace(/\/$/, "");
                var host = new URL(reference, url).host;

                if (host.endsWith("." + new URL(url).host)) {
                    // Prevent some subdomain abuse
                    host = new URL(url).host;
                }

                if (!(newUrl.startsWith("http://") || newUrl.startsWith("https://"))) {
                    return;
                }

                if (pagesToCrawl.includes(newUrl)) {
                    return;
                }

                additionsPerHost[host] ||= 0;

                if (additionsPerHost[host] <= MAX_CRAWL_ADDITIONS_PER_HOST) {
                    additionsPerHost[host]++;

                    console.log(`Discovered page: ${newUrl}`);
    
                    crawlStats.added++;
    
                    pagesToCrawl.splice(Math.floor((pagesToCrawl.length + 1) * Math.random()), 0, newUrl);
                }

                saveCrawlLists();
            });

            fs.appendFileSync("data/corpus.txt", pageText.replace(/\s+/g, " ") + "\x04");

            console.log(`Crawl complete: ${url}`);

            crawlStats.crawled++;

            return Promise.resolve();
        });
    }).catch(function(error) {
        console.warn(`Crawl error: ${url}`, error);

        crawlStats.skipped++;

        return Promise.resolve();
    });
}

function getNextToCrawl() {
    console.log("Crawl stats:", crawlStats);

    if (pagesToCrawl.length == 0) {
        console.log("Got to end of crawl list");

        return Promise.resolve();
    }

    var index = Math.round((Math.random() ** 2) * Math.min(pagesToCrawl.length - 1, MAX_SELECT_TOP_TO_CRAWL)); // Algorithm to favour items near top of list
    var pageToCrawl = pagesToCrawl[index];

    pagesToCrawl.splice(index, 1);

    saveCrawlLists();

    return crawlPage(pageToCrawl).then(function() {
        return new Promise(function(resolve, reject) {
            console.log("Pausing...");

            setTimeout(function() {
                console.log("Pause complete");

                resolve();
            }, CRAWL_PAUSE_DURATION);
        });
    }).then(function() {
        return getNextToCrawl();
    });
}

if (fs.existsSync("data/crawled.tsv")) {
    pagesCrawled = arrayToObject(tsvToObjects(fs.readFileSync("data/crawled.tsv", "utf-8")), "url");

    console.log("Loaded crawled pages list");
}

getNextToCrawl().then(function() {
    console.log("Final indexes:", indexes);
});