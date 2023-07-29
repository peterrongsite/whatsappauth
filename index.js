const express = require("express");
const app = express();
const qrcode = require("qrcode");
const axios = require("axios");
const { Client, RemoteAuth } = require("whatsapp-web.js");
const { MessageMedia } = require("whatsapp-web.js");
const fs = require("fs");
const mysql = require("mysql2");
const validUrl = require("valid-url");
const session = require("express-session"); // Import express-session

const mongoose = require("mongoose");
const { MongoStore } = require("wwebjs-mongo");
const MONGO_URI = "mongodb://0.0.0.0/remoteauth";

let store;

// use this anywhere to use the client
let clientStoreReference = {};
mongoose.connect(MONGO_URI).then(() => {
  // you can move this logic to a function and use it again whenever you want to spawn a client
  console.log("Mongo Db connected");
  store = new MongoStore({ mongoose: mongoose });

  const client = new Client({
    puppeteer: {
      headless: false,
    },
    authStrategy: new RemoteAuth({
      clientId: "BOT1", // give a unique ID to the bot
      store: store,
      backupSyncIntervalMs: 300000,
    }),
  });

  client.on("ready", () => {
    console.log("Client is ready!");

    // use this client every where
    clientStoreReference = {
      client,
    };
  });
  client.on("qr", (qr) => {
    qrcode.generate(qr, { small: true });
    console.log("QR RECEIVED", qr);
  });
  client.on("authenticated", () => {
    console.log("authenticated  Call");
  });
  client.on("remote_session_saved", () => {
    // this call back is triggered when we have successfully stored the authentication for the account, close the session locally only when you see this call back, otherwise this will not revive the session
    console.log("Remote Authe Session Saved");
  });
  client.initialize();
});

const clients = {}; // Define the 'clients' object

const connection = mysql.createConnection({
  host: "localhost",
  user: "root",
  password: "",
  database: "wasender",
});

// Connect to the MySQL database
connection.connect((error) => {
  if (error) {
    console.error("Error connecting to the database:", error);
    return;
  }
  console.log("Connected to the database");
});

function retrieveAndCreateClients() {
  const query = "SELECT token FROM instance";
  connection.query(query, (error, results) => {
    if (error) {
      console.error("Error retrieving device IDs:", error);
      return;
    }
    const devicees = results.map((row) => row.token);
    // console.log('Retrieved device IDs:', devicees);

    // Check for new devices and create clients for them
    devicees.forEach((deviceId) => {
      if (!clients[deviceId]) {
        // create clients with the logic that I have given above on line no. 20 after the mongoose connection is done
        createClient(deviceId);
      }
    });

    // Remove clients for devices that are no longer in the database
    for (const deviceId in clients) {
      if (!devicees.includes(deviceId)) {
        resetClient(deviceId);
        delete clients[deviceId];
      }
    }
  });
}

// Set an interval to periodically check for new devices every 5 seconds
const intervalSeconds = 1;
setInterval(retrieveAndCreateClients, intervalSeconds * 1000);

// Rest of your code...

// ...

// ...

// ...

app.post("/:deviceId/send-message", express.json(), (req, res) => {
  const recipient = req.body.recipient;
  const message = req.body.message;
  const client = clients[req.params.deviceId].client;

  client
    .sendMessage(recipient, message)
    .then(() => {
      res.send("Message sent successfully");
    })
    .catch((error) => {
      console.error("Error sending message:", error);
      res.send("Error sending message");
    });
});

// ...

// ...

app.post("/:deviceId/send-media", express.json(), async (req, res) => {
  const recipient = req.body.recipient;
  const mediaUrl = req.body.mediaUrl;
  const caption = req.body.caption;

  const client = clients[req.params.deviceId].client;

  try {
    // Check if the mediaUrl is a valid URL
    if (!validUrl.isWebUri(mediaUrl)) {
      res.status(400).json({ error: "Invalid media URL" });
      return;
    }

    const response = await axios.get(mediaUrl, { responseType: "arraybuffer" });
    const mediaData = response.data;

    // Check if the response contains media data
    if (!mediaData || mediaData.length === 0) {
      res.status(400).json({ error: "Invalid media data or media not found" });
      return;
    }

    const mediaFilePath = "temp-media-file.jpg";
    fs.writeFileSync(mediaFilePath, mediaData);

    const media = MessageMedia.fromFilePath(mediaFilePath);

    await client.sendMessage(recipient, media, { caption: caption });

    fs.unlinkSync(mediaFilePath);

    res
      .status(500)
      .json({ ResultCode: "200", error: "Media Sent Successfully" });
  } catch (error) {
    console.error("Error sending media message:", error);
    res
      .status(500)
      .json({ ResultCode: "201", error: "Error sending media message" });
  }
});

app.post("/:deviceId/disconnect", (req, res) => {
  const deviceId = req.params.deviceId;
  const client = clients[deviceId]?.client;

  if (client) {
    client
      .logout()
      .then(() => {
        console.log(`Client for device ${deviceId} disconnected`);
        res.send(`Client for device ${deviceId} disconnected`);
      })
      .catch((error) => {
        console.error(`Error occurred during client logout: ${error}`);
        res.status(500).send("Error occurred during client logout");
      });
  } else {
    res.status(404).send("Client not found for the specified device ID");
  }
});

app.get("/:deviceId/qrcode", (req, res) => {
  const qrCodeDataUrl = clients[req.params.deviceId].qrCodeDataUrl;

  if (qrCodeDataUrl) {
    res.send(`<img src="${qrCodeDataUrl}">`);
  } else {
    res.send("QR code not available yet");
  }
});

app.post("/:deviceId/qrcode-data", express.json(), (req, res) => {
  const qrCodeDataUrl = req.body.qrCodeDataUrl;
  clients[req.params.deviceId].qrCodeDataUrl = qrCodeDataUrl;
  res.sendStatus(200);
});

// ...

function createClient(deviceId) {
  const client = new Client();
  clients[deviceId] = {
    qrCodeDataUrl: null,
    client: client,
  };

  function generateQrCode() {
    client.on("qr", (qr) => {
      qrcode.toDataURL(qr, (err, dataUrl) => {
        if (err) {
          console.error(err);
          // Handle the error accordingly
        }
        clients[deviceId].qrCodeDataUrl = dataUrl;
      });
    });
  }

  // Generate the initial QR code
  generateQrCode();

  // Handle the session and QR code updates
  client.on("authenticated", (session) => {
    console.log(`Device ${deviceId} authenticated`);

    // Update the device status to 1 in the database
    const updateQuery = "UPDATE instance SET active = 1 WHERE token = ?";
    connection.query(updateQuery, [deviceId], (error, results) => {
      if (error) {
        console.error("Error updating device status:", error);
        // Handle the error accordingly
      }
      console.log(`Device ${deviceId} status updated to 1`);
    });
  });

  // ... rest of the code

  // ...

  client.on("message", async (msg) => {
    const phoneNumber = msg.from;
    const senderName = msg._data.notifyName;
    const message = msg.body;

    // Filter messages from groups and broadcasts
    if (msg.isGroupMsg || msg.isBroadcast) {
      //  console.log('Message filtered: Not processing messages from groups or broadcasts.');
      return; // Skip further processing for these messages
    }

    // Filter messages from the specific phone number
    if (phoneNumber === "status@broadcast") {
      // console.log('Message filtered: Not processing messages from the specific phone number.');
      return; // Skip further processing for these messages
    }

    console.log("Received message:");
    console.log("Phone Number:", phoneNumber);
    console.log("Sender Name:", senderName);
    console.log("Message:", message);

    let mediaUrl = null; // Initialize mediaUrl as null

    if (msg.hasMedia) {
      const mediaData = await msg.downloadMedia();

      // Save the media to a file
      const fileName = `${Date.now()}.${mediaData.mimetype.split("/")[1]}`;
      const filePath = `uploads/${fileName}`;
      fs.writeFileSync(filePath, mediaData.data, "base64");
      console.log("Media saved:", fileName);

      // Set mediaUrl if media is present
      mediaUrl = `http://localhost/node/${filePath}`;
    }

    // Send webhook data
    try {
      await axios.post("http://localhost/node/webhook.php", {
        phoneNumber: phoneNumber,
        senderName: senderName,
        message: message,
        mediaUrl: mediaUrl, // Include mediaUrl in the payload
      });
    } catch (error) {
      console.error("Error sending webhook:", error);
    }
  });

  client.on("disconnected", (reason) => {
    console.log(`Device ${deviceId} disconnected. Reason: ${reason}`);

    // Update the device status to 0 in the database
    const updateQuery = "UPDATE instance SET active = 0 WHERE token = ?";
    connection.query(updateQuery, [deviceId], (error, results) => {
      if (error) {
        console.error("Error updating device status:", error);
        // Handle the error accordingly
      }
      console.log(`Device ${deviceId} status updated to 0`);
    });

    // Handle client disconnection here
    // You can take appropriate actions, such as attempting to reconnect
  });

  client.initialize();
}

function resetClient(deviceId) {
  const client = clients[deviceId]?.client;
  if (client) {
    const browser = client.pupBrowser;
    if (browser) {
      client
        .destroy()
        .then(() => {
          client.initialize(); // Initialize a new client instance
        })
        .catch((error) => {
          console.error(`Error occurred during client destruction: ${error}`);
        });
    } else {
      console.log(`No browser instance found for deviceId: ${deviceId}`);
    }
  } else {
    console.log(`No client found for deviceId: ${deviceId}`);
  }
}

app.listen(3333, () => {
  console.log("Server is running on http://localhost:3333");
});
