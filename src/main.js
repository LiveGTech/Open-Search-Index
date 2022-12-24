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

const RE_MATCH_ALL_WORDS = /[\w']+/g;

var pagesToCrawl = fs.readFileSync("data/tocrawl.txt", "utf-8").split("\n").filter((line) => line != "");
var pagesCrawled = [];
var indexes = {};

function findCommonWords(text) {
    var words = {};

    [...text.matchAll(RE_MATCH_ALL_WORDS)].forEach(function(match) {
        var word = match[0].toLocaleLowerCase();

        words[word] ||= 0;
        words[word]++;
    });

    return Object.keys(words)
        .map((word) => ({word, count: words[word]}))
        .sort((a, b) => b.count - a.count) // Sort by count, descending
    ;
}

function crawlPage(url, depth = MAX_CRAWL_DEPTH) {
    if (pagesCrawled.includes(url)) {
        console.log(`Already crawled: ${url}`);

        return Promise.resolve();
    }

    console.log(`Crawling: ${url}`);

    pagesCrawled.push(url);

    return fetch(url).then(function(response) {
        if (response.status != 200) {
            console.log(`Non-200 skip: ${url}`);

            return Promise.resolve();
        }

        return response.text().then(function(data) {
            var dom = new jsdom.JSDOM(data).window.document;

            dom.querySelectorAll("script, style, button, input, select, label").forEach((element) => element.remove());

            var pageTitle = dom.querySelector("title")?.textContent;
            var pageText = dom.querySelector("body")?.textContent;

            if (!pageTitle || !pageText) {
                console.log(`No text data skip: ${url}`);

                return Promise.resolve();
            }

            var titleWords = [...pageTitle.matchAll(RE_MATCH_ALL_WORDS)].map((match) => match[0].toLocaleLowerCase());
            var commonWords = findCommonWords(pageText);
            var wordSet = new Set([...titleWords, ...commonWords.map((item) => item.word)]);

            console.log(commonWords);
            console.log(wordSet);
        });
    });
}

crawlPage(pagesToCrawl);