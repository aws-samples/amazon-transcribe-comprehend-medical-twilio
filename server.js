// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT

const express = require("express");
const socket = require("socket.io");
const bodyParser = require("body-parser");
const expressWebSocket = require("express-ws");
const Transform = require("stream").Transform;
const websocketStream = require("websocket-stream/stream");
const WaveFile = require("wavefile").WaveFile;
const AmazonTranscribeService = require("./lib/transcribe-service");
const TwilioClient = require("twilio");
const config = require("./config.json");
let exphbs = require("express-handlebars");

// AWS SDK
const AWS = require("aws-sdk");
AWS.config.update({ region: "us-east-1" });

// const kendra = new AWS.Kendra();
const comprehend = new AWS.Comprehend();
const comprehendMedical = new AWS.ComprehendMedical();
const s3 = new AWS.S3();
const ddb = new AWS.DynamoDB.DocumentClient();

// ML helper functions
// upload transcription text to s3
const uploadTranscriptionToS3 = (bucket, key, transcription) => {
  const params = {
    Bucket: bucket,
    Key: key,
    Body: transcription,
  };
  s3.upload(params, function (err, data) {
    if (err) console.log(err, err.stack);
    else return data;
  });
};

// comprehend medical detect entities
const comprehendMedicalDetectEntities = (medicalText) => {
  const comprehendMedicalParams = {
    Text: medicalText,
  };

  let entities = comprehendMedical.detectEntitiesV2(
    comprehendMedicalParams,
    function (err, data) {
      if (err) console.log(err, err.stack);
      else return data;
    }
  );

  for (let i = 0; i < entities.length; i++) {
    if (entities[i].Category !== "PERSONAL_IDENTIFIABLE_INFORMATION") {
      let params = {
        TableName: ddbTable,
        Item: {
          ROWID: rowid,
          ID: entities[i].Id,
          Text: entities[i].Text,
          Type: entities[i].Type,
          Category: entities[i].Category,
          Score: entities[i].Score,
          Trait_List: JSON.stringify(entities[i].Traits),
          Attribute_List: JSON.stringify(entities[i].Attributes),
          Call_id: callSid,
        },
      };
      ddb.put(params, function (err, data) {
        if (err) {
          console.error(
            "Unable to add item. Error JSON:",
            JSON.stringify(err, null, 2)
          );
        }
      });
      rowid = rowid + 1;
    }
  }
};

// comprehend detect sentiment
const comprehendDetectSentiment = (transcription) => {
  const comprehend_params = {
    LanguageCode: "en",
    Text: transcription,
  };
  comprehend.detectSentiment(comprehend_params, function (err, data) {
    if (err) console.log(err, err.stack);
    else console.log(data);
  });
};

// // kendra query
// const kendraQuery = (kendraIndexId, transcription) => {
//   const kendraParams = {
//     IndexId: kendraIndexId, // replace IndexId with Kendra Index
//     QueryText: transcription,
//   };
//   kendra.query(kendraParams, function (err, data) {
//     if (err) console.log(err, err.stack);
//     else return data.ResultItems;
//   });
// };

// variables
let creds;
let transcriptionText = "";
let callSid;
let rowid = Math.floor(Math.random() * 201);
const PORT = process.env.PORT || 5000;
const ddbTable = config.ddb_table;
const s3Bucket = config.s3_bucket;

// express app initialize
const app = express();
let hbs = exphbs.create();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
// extend express app with app.ws()
expressWebSocket(app, null, {
  perMessageDeflate: false,
});
app.engine("hbs", hbs.engine);

app.set("view engine", "hbs");
// <ake all the files in 'public' available
app.use(express.static("public"));

app.get("/", (request, response) => {
  response.render("home", {
    layout: false,
    transcriptionText: transcriptionText,
  });
});

app.post("/creds", (request, response) => {
  creds = request.body;
  console.log(creds);
  response.send({ success: "success" });
});

// Responds with Twilio instructions to begin the stream
app.post("/twiml", (request, response) => {
  response.setHeader("Content-Type", "application/xml");
  response.render("twiml", { host: request.hostname, layout: false });
});

app.ws("/media", (ws, req) => {
  // Audio Stream coming from Twilio
  transcriptionText = "";
  const mediaStream = websocketStream(ws);
  const client = new TwilioClient(
    creds.twilio_account_sid,
    creds.twilio_auth_token
  );
  const audioStream = new Transform({
    transform: (chunk, encoding, callback) => {
      const msg = JSON.parse(chunk.toString("utf8"));
      if (msg.event === "start") {
        // call SID
        callSid = msg.start.callSid;
        console.log(`Captured call ${callSid}`);
      }
      // Only process media messages
      if (msg.event !== "media") return callback();
      return callback(null, Buffer.from(msg.media.payload, "base64"));
    },
  });
  const pcmStream = new Transform({
    transform: (chunk, encoding, callback) => {
      const wav = new WaveFile();
      wav.fromScratch(1, 16000, "16", chunk);
      wav.fromMuLaw();
      return callback(null, Buffer.from(wav.data.samples));
    },
  });
  const transcribeService = new AmazonTranscribeService(
    pcmStream,
    creds.access_id,
    creds.secret_key
  );
  // Pipe our streams together
  mediaStream.pipe(audioStream).pipe(pcmStream);
  transcribeService.on("transcription", (transcription) => {
    console.log(`Processing ${transcription}`);
    comprehendDetectSentiment(transcription);
    transcriptionText += transcription + "\n";
  });

  mediaStream.on("close", () => {
    transcribeService.stop();
    const transcriptionKey = "transcription/" + callSid + "-transcription";
    uploadTranscriptionToS3(s3Bucket, transcriptionKey, transcriptionText);
    comprehendMedicalDetectEntities(transcriptionText);
  });
});

const listener = app.listen(PORT, () => {
  console.log("Your app is listening on port " + listener.address().port);
});

let interval;

const io = socket(listener);

const getTranscriptionAndEmit = (socket) => {
  socket.emit("FromAPI", transcriptionText);
};

io.on("connection", (socket) => {
  console.log("New Connection");
  if (interval) {
    clearInterval(interval);
  }
  interval = setInterval(() => getTranscriptionAndEmit(socket), 1000);
});
