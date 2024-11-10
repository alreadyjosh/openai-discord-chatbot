const mongodb = require("mongodb");
require("dotenv").config();

const mongoclient_main = new mongodb.MongoClient(process.env.MONGODB_DB);

mongoclient_main.connect().then(async () => {
    console.log("Connection to the Main Database established")
}).catch(() => {
    console.log("Failed to connect to the Main DB")
});

module.exports = mongoclient_main;