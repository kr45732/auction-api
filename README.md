# Auction query API
Two versatile API facades for the Hypixel Auction API. The `pet_api.js` tracks the average prices of each unique pet level and rarity. The `query_api.js` lets you query all active auctions using item name, id, enchants, and much more!  

## Set up
### Prerequisites
- [Node.js](https://nodejs.org/)
- [MongoDB](https://www.mongodb.com/)
- [Discord](https://discord.com/)

### Steps
- Clone the repository
- Set the three environment variables
- Run either api using node
- Use it!

### Environment Variables
- `API_KEY`: Api key needed to access this api (NOT a Hypixel API key)
- `DATABASE_URI`: Full url for the MongoDB
- `WEBHOOK_URL`: Discord webhook url for logging