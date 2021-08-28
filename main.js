const express = require('express')
const fetch = require('node-fetch')
const { MongoClient } = require('mongodb')
const JSON5 = require('json5')

const app = express()

let db
let skyblockDB
let config = {
    pageSize: 20
}

/* Update database */
async function startAuctionHouseLoop() {
    while (true) {
        let ahStartTime = Date.now()
        let ah = await getFullAuctionHouse()
        let ahFinishTime = Date.now()

        if (ah.failedPages.length != 0) {
            console.warn(`Failed to get ${ah.failedPages.length} pages. Successfully got ${ah.completedPages.length} pages`)
        }

        console.log(`Got ${ah.auctions.length} auctions, inserting...`)

        let collection = skyblockDB.collection("sb")
        collection.drop()
        let databaseStartTime = Date.now()
        collection.insertMany(ah.auctions, async () => {
            console.log(`Inserted ${ah.auctions.length} auctions in ${Date.now() - databaseStartTime}ms\n`)
        })

        console.log(`Total auction fetch time: ${ahFinishTime - ahStartTime}ms. Extra time: ${Date.now() - ahStartTime}ms - ${Date().toLocaleString('en-US', { timeZone: 'EST' })}`)

        let nextUpdate = (await getSecondsUntilApiUpdate()) * 5000
        console.log(`Next update in ${nextUpdate}ms\n`)

        await sleep(nextUpdate)
    }
}

/* Helper functions */
async function getFullAuctionHouse() {
    let totalPages = (await getAuctionPage(0)).totalPages
    console.log(`Fetching ${totalPages} pages of auction`)

    let res = await new Promise(async (resolve) => {
        let completedPages = []
        let failedPages = []
        let ah = []
        for (let pageNum = 0; pageNum < totalPages; pageNum++) {
            getAuctionPage(pageNum).then((page) => {
                for (i of page.auctions) {
                    if (i["item_lore"].includes("Right-click to add this pet to\n§eyour pet menu") && i["bin"]) {
                        ah.push({
                            item_name: i["item_name"],
                            starting_bid: i["starting_bid"],
                            tier: i["tier"]
                        })
                    }
                }

                completedPages.push(pageNum)

                if ((completedPages.length + failedPages.length) === totalPages)
                    return resolve({
                        success: true,
                        auctions: ah,
                        completedPages: completedPages,
                        failedPages: failedPages
                    })
            }).catch((e) => {
                failedPages.push(pageNum)
                console.error(`Failed to get page ${pageNum}, Failed ${failedPages.length} pages so far.`)
                if ((completedPages.length + failedPages.length) === totalPages)
                    return resolve({
                        success: true,
                        auctions: ah,
                        completedPages: completedPages,
                        failedPages: failedPages
                    })
            })
        }
    })

    return res
}

async function getAuctionPage(page = 0) {
    return fetch(`https://api.hypixel.net/skyblock/auctions?page=${page}`).then((res) => {
        if (!res.ok) {
            throw new Error(res)
        }
        return res.json()
    })
}

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

async function getSecondsUntilApiUpdate() {
    let req = await fetch(`https://api.hypixel.net/skyblock/auctions?page=0`)
    let age = Number(req.headers.get('age'))

    if (age == null) {
        return 0
    }

    let maxAge = Number(req.headers.get('cache-control').split('s-maxage=')[1]) || 60
    return maxAge - age + 2 || 50
}

/* Express App */
app.get('/skyblock/auctions/', async (req, res) => {
    res.setHeader('Content-Type', 'application/json')

    if (req.query.key != process.env['API_KEY']) {
        res.status(404).send({ error: "Unauthorized" })
        return
    }

    console.log(`New request: ${req.url.replace(
        process.env['API_KEY'], "[REMOVED]"
    )}`)

    query = req.query.query || req.query.q || '{}'
    page = Number(req.query.page) || Number(req.query.p) || 0
    sort = req.query.sort || req.query.s || '{}'
    limit = Number(req.query.limit) || Number(req.query.l) || 9999999999999999
    filter = req.query.filter || req.query.f || '{}'

    if (req.query.aggregate) {
        let aggregate
        try {
            aggregate = JSON5.parse(req.query.aggregate)
        } catch (e) {
            res.status(400).send({ error: 'Invalid JSON provided.' })
            return
        }

        return skyblockDB.collection("sb").aggregate(aggregate).toArray().then((found) => {
            res.json(found)
        })
    }

    try {
        query = JSON5.parse(query)
        sort = JSON5.parse(sort)
        filter = JSON5.parse(filter)
        filter['_id'] = 0
    } catch (e) {
        return res.status(400).json({ error: 'Invalid JSON provided.' })
    }

    if (typeof (query) != 'object' || typeof (page) != 'number' || typeof (sort) != 'object' || typeof (limit) != 'number' || typeof (filter) != 'object') {
        return res.status(400).json({ error: 'Invalid data type provided' })
    }

    let skipSize = page * config.pageSize
    skyblockDB.collection("sb").find(query, { allowDiskUse: true }).sort(sort).skip(skipSize).limit(req.query.page === undefined ? limit : config.pageSize).project(filter).toArray(async (err, found) => {
        if (err) {
            return res.status(500).json({ error: err })
        }

        res.json(found)
    })
})

app.listen(3000, async () => {
    MongoClient.connect(process.env['DATABASE_URI'], { useNewUrlParser: true, useUnifiedTopology: true }, (err, DB) => {
        db = DB
        skyblockDB = DB.db('skyblock')
    })

    while (typeof db == 'undefined') {
        await sleep(10)
    }

    console.log("Successfully connected to the database. Server started. Starting auction loop.")

    startAuctionHouseLoop()
})