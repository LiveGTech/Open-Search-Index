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

const fetch = function(...args) {
    return import("node-fetch").then(function({default: fetch}) {
        return fetch(...args);
    });
}

const MAX_CRAWL_DEPTH = 10;
const MIN_WORD_COUNT_AS_KEYWORD = 3;
const CRAWL_TIMEOUT_DURATION = 5_000;
const CRAWL_PAUSE_DURATION = 3_000;

const RE_MATCH_ALL_WORDS = /[\w']+/g;

const INDEX_FIELDS = ["url", "title", "description", "firstIndexed", "lastUpdated", "referenceScore", "keywordScore"];

var pagesToCrawl = fs.readFileSync("data/tocrawl.txt", "utf-8").split("\n").filter((line) => line != "");
var pagesCrawled = [];
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

function crawlPage(url) {
    if (pagesCrawled.includes(url)) {
        console.log(`Already crawled: ${url}`);

        crawlStats.skipped++;

        return Promise.resolve();
    }

    console.log(`Crawling: ${url}`);

    pagesCrawled.push(url); // TODO: Maybe save this to a file

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

            var pageTitle = dom.querySelector("title")?.textContent;
            var pageDescription = dom.querySelector("meta[name='description']")?.getAttribute("content");
            var pageText = dom.querySelector("body")?.textContent;

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
                    title: pageTitle,
                    description: pageDescription || "",
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
                    entry.referenceScore = Math.min(currentEntry.referenceScore + (1 / 100), 1);

                    Object.assign(currentEntry, entry);
                } else {
                    indexes[word].push(entry);
                }

                saveIndex(word);
            });

            [...dom.querySelectorAll("a[href]")].forEach(function(element) {
                var reference = element.getAttribute("href");
                var newUrl = new URL(reference, url).href.split("#")[0];

                if (newUrl.startsWith("http://") || newUrl.startsWith("https://")) {
                    return;
                }

                if (pagesToCrawl.includes(newUrl) || pagesCrawled.includes(newUrl)) {
                    // TODO: Figure out a way of allowing reference score going up only from third-party sites (without circular dependencies)
                    return; // TODO: Add freshness (page age) theshold for already-crawled pages
                }

                console.log(`Discovered page: ${newUrl}`);

                pagesToCrawl.push(newUrl); // TODO: Maybe save this to a file
            });

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

    return crawlPage(pagesToCrawl.shift()).then(function() {
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

getNextToCrawl().then(function() {
    console.log("Final indexes:", indexes);
});