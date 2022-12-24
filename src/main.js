/*
    LiveG Open Search Index

    Copyright (C) LiveG. All Rights Reserved.

    https://search.liveg.tech
    Licensed by the LiveG Open-Source Licence, which can be found at LICENCE.md.
*/

const fs = require("fs");
const jsdom = require("jsdom");

const fetch = function(...args) {
    return import("node-fetch").then(function({default: fetch}) {
        return fetch(...args);
    });
}

const MAX_CRAWL_DEPTH = 10;
const MIN_WORD_COUNT_AS_KEYWORD = 3;
const CRAWL_TIMEOUT_DURATION = 3_000;
const CRAWL_PAUSE_DURATION = 3_000;

const RE_MATCH_ALL_WORDS = /[\w']+/g;

var pagesToCrawl = fs.readFileSync("data/tocrawl.txt", "utf-8").split("\n").filter((line) => line != "");
var pagesCrawled = [];
var crawlStats = {added: 0, crawled: 0, skipped: 0};
var indexes = {};

function findCommonWords(text) {
    var words = {};

    [...text.matchAll(RE_MATCH_ALL_WORDS)].forEach(function(match) {
        var word = match[0].toLocaleLowerCase();

        words[word] ||= 0;
        words[word]++;
    });
    
    return words;
}

function crawlPage(url) {
    if (pagesCrawled.includes(url)) {
        console.log(`Already crawled: ${url}`);

        crawlStats.skipped++;

        return Promise.resolve();
    }

    console.log(`Crawling: ${url}`);

    pagesCrawled.push(url);

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

            var titleWords = [...pageTitle.matchAll(RE_MATCH_ALL_WORDS)].map((match) => match[0].toLocaleLowerCase());
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

                indexes[word] ||= [];

                var currentEntry;

                if (currentEntry = indexes[word].find((currentEntry) => currentEntry.url == entry.url)) {
                    entry.firstIndexed = currentEntry.firstIndexed;
                    entry.referenceScore = Math.min(currentEntry.referenceScore + (1 / 100), 1);

                    Object.assign(currentEntry, entry);
                } else {
                    indexes[word].push(entry);
                }
            });

            console.log(`Crawl complete: ${url}`);

            crawlStats.crawled++;

            return Promise.resolve();
        });
    }).catch(function(error) {
        console.warn(`Error: ${url}`, error);

        crawlStats.skipped++;

        return Promise.resolve();
    });
}

function getNextToCrawl() {
    console.log("Crawl stats:", crawlStats);

    if (pagesToCrawl.length == 0) {
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
    console.log("Got to end of crawl list");

    console.log(indexes);
});