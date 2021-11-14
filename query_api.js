const express = require('express')
const fetch = require('node-fetch')
const { MongoClient } = require('mongodb')
const JSON5 = require('json5')
const { Webhook } = require("webhook-discord")
const nbt = require('nbt')

const app = express()
const webhook = new Webhook(process.env.WEBHOOK_URL)

let db
let skyblockDB

let pageInfo = {
    start_time: Date.now(),
    start_time_formatted: new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }),
    last_updated: Date.now(),
    last_updated_formatted: null,
    last_total_pages: null,
    last_completed_pages: null,
    last_failed_pages: null,
    currently_updating: false,
    total_updates: 0,
    authorized_requests: 0,
    unauthorized_requests: 0
}

let mcCodeRegex = new RegExp(/\u00A7[0-9A-FK-OR]/mgi);

const collectionName = "query"

/* Update database */
async function startAuctionHouseLoop() {
    while (true) {
        let ahStartTime = Date.now()
        pageInfo.currently_updating = true
        let ah = await getFullAuctionHouse()
        pageInfo.currently_updating = false
        pageInfo.total_updates++
        let ahFinishTime = Date.now()

        pageInfo.last_updated = Date.now()
        pageInfo.last_completed_pages = ah.completedPages.length
        pageInfo.last_failed_pages = ah.failedPages.length
        pageInfo.last_total_pages = pageInfo.last_completed_pages + pageInfo.last_failed_pages

        if (ah.failedPages.length != 0) {
            sendWebhookErrorMessage(`Failed to get ${ah.failedPages.length} pages\nSuccessfully got ${ah.completedPages.length} pages`)
        }

        sendWebhookInfoMessage(`Got ${ah.auctions.length} auctions, inserting...`)

        let collection = skyblockDB.collection(collectionName)
        collection.drop()
        let databaseStartTime = Date.now()
        collection.insertMany(ah.auctions, async () => {
            sendWebhookInfoMessage(`Inserted ${ah.auctions.length} auctions in ${Date.now() - databaseStartTime}ms\n`)
        })

        sendWebhookInfoMessage(`Total auction fetch time: ${ahFinishTime - ahStartTime}ms\nExtra time: ${Date.now() - ahStartTime}ms`)

        await sleep(240000)
        await sleep((await getSecondsUntilApiUpdate()) * 1000)
    }
}

/* Helper functions */
async function getFullAuctionHouse() {
    let totalPages = (await getAuctionPage(0)).totalPages
    sendWebhookInfoMessage(`Fetching ${totalPages} auction pages...`)

    let res = await new Promise(async (resolve) => {
        let completedPages = []
        let failedPages = []
        let newAuctionData = []
        for (let pageNum = 0; pageNum < totalPages; pageNum++) {
            await getAuctionPage(pageNum).then(async (page) => {
                for (let i = 0; i < page.auctions.length; i++) {
                    let thisAuction = page.auctions[i];
                    if (thisAuction["bin"]) {
                        await parse(Buffer.from(thisAuction["item_bytes"], "base64")).then(data => {
                            let enchants;
                            try {
                                let allEnchants = data.value.i.value.value[0].tag.value.ExtraAttributes.value.enchantments.value
                                enchants = []
                                for (const ench in allEnchants) {
                                    enchants.push(`${ench};${allEnchants[ench].value}`.toUpperCase())
                                }
                            } catch (e) { }

                            newAuctionData.push({
                                uuid: thisAuction.uuid,
                                auctioneer: thisAuction.auctioneer,
                                end: thisAuction.end,
                                item_name: (thisAuction.item_name != "Enchanted Book" ? thisAuction.item_name : thisAuction.item_lore.split("\n")[0].replace(mcCodeRegex, "")),
                                tier: thisAuction.tier,
                                starting_bid: thisAuction.starting_bid,
                                item_id: data.value.i.value.value[0].tag.value.ExtraAttributes.value.id.value,
                                enchants: enchants
                            })

                        }).catch(error => {
                            sendWebhookErrorMessage(error)
                        })
                    }
                }

                completedPages.push(pageNum)

                if ((completedPages.length + failedPages.length) === totalPages)
                    return resolve({
                        success: true,
                        auctions: newAuctionData,
                        completedPages: completedPages,
                        failedPages: failedPages
                    })
            }).catch((e) => {
                failedPages.push(pageNum)
                sendWebhookErrorMessage(`Failed to get page ${pageNum}\nFailed ${failedPages.length} pages so far\n\n\`\`\`js${e}\`\`\``)
                if ((completedPages.length + failedPages.length) === totalPages)
                    return resolve({
                        success: true,
                        auctions: newAuctionData,
                        completedPages: completedPages,
                        failedPages: failedPages
                    })
            })
        }
    })

    return res
}

async function parse(data) {
    return new Promise((resolve, reject) => {
        nbt.parse(data, (error, datax) => {
            if (error) {
                return reject(error)
            }

            return resolve(datax)
        })
    })
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

async function sendWebhookInfoMessage(message) {
    webhook.info("Auction API Logger", message)
}

async function sendWebhookErrorMessage(message) {
    webhook.err("Auction API Logger", message)
}

/* Express App */
app.get('/', async (req, res) => {
    res.setHeader('Content-Type', 'application/json')

    if (req.query.key != process.env.API_KEY) {
        pageInfo.unauthorized_requests++
        res.status(404).send({ error: "Unauthorized" })
        return
    }

    pageInfo.authorized_requests++
    console.log(`New request from ${req.ip}`)

    query = req.query.query || req.query.q || '{}'
    page = Number(req.query.page) || Number(req.query.p) || 0
    sort = req.query.sort || req.query.s || '{}'
    limit = Number(req.query.limit) || Number(req.query.l) || 9999999999999999
    filter = req.query.filter || req.query.f || '{}'

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

    let skipSize = page * 20
    skyblockDB.collection(collectionName).find(query, { allowDiskUse: true }).sort(sort).skip(skipSize).limit(req.query.page === undefined ? limit : 20).project(filter).toArray(async (err, found) => {
        if (err) {
            m
            return res.status(500).json({ error: err })
        }

        res.json(found)
    })
})

app.get("/information", async (req, res) => {
    pageInfo.last_updated_formatted = `${(Date.now() - pageInfo.last_updated) / 1000.0} seconds ago`
    res.json(pageInfo)
})

app.listen(process.env.PORT || 3000, async () => {
    MongoClient.connect(process.env.DATABASE_URI, { useNewUrlParser: true, useUnifiedTopology: true }, (err, DB) => {
        db = DB
        skyblockDB = DB.db('skyblock')
    })

    while (typeof db == 'undefined') {
        await sleep(10)
    }

    sendWebhookInfoMessage("Server started. Successfully connected to the database.Starting auction loop.")

    startAuctionHouseLoop()
})