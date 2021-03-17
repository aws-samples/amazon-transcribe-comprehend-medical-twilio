/* MIT License

Copyright (c) 2021 TwilioDevEd
Portions Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Copied from https://github.com/TwilioDevEd/talkin-cedric-node/blob/master/transcribe-service.js
*/

const EventEmitter = require("events");
const Transform = require("stream").Transform;
const websocket = require("websocket-stream");
const crypto = require("crypto");
const marshaller = require("@aws-sdk/eventstream-marshaller"); // for converting binary event stream messages to and from JSON
const util_utf8_node = require("@aws-sdk/util-utf8-node"); // utilities for encoding and decoding UTF8
const v4 = require("./aws-signature-v4"); // to generate our pre-signed URL

// our converter between binary AWS event stream messages and JSON
const eventStreamMarshaller = new marshaller.EventStreamMarshaller(
  util_utf8_node.toUtf8,
  util_utf8_node.fromUtf8
);

function getAudioEventMessageTransformer() {
  return new Transform({
    transform: (chunk, encoding, callback) => {
      const message = {
        headers: {
          ":message-type": {
            type: "string",
            value: "event",
          },
          ":event-type": {
            type: "string",
            value: "AudioEvent",
          },
        },
        body: Buffer.from(chunk),
      };
      const binary = eventStreamMarshaller.marshall(message);
      return callback(null, Buffer.from(binary));
    },
  });
}

function getAwsEventTransformerStream() {
  return new Transform({
    transform: (chunk, encoding, callback) => {
      const messageWrapper = eventStreamMarshaller.unmarshall(
        Buffer.from(chunk)
      );
      const messageBody = JSON.parse(
        String.fromCharCode.apply(String, messageWrapper.body)
      );
      if (messageWrapper.headers[":message-type"].value === "event") {
        const results = messageBody.Transcript.Results;
        if (results.length === 0) return callback();
        let transcript = results[0].Alternatives[0].Transcript;
        transcript = decodeURIComponent(escape(transcript));
        if (results[0].IsPartial) {
          console.log(`Partial transcript: ${transcript}`);
          return callback();
        } else {
          console.log(`Full transcript: ${transcript}`);
          return callback(null, transcript);
        }
      } else {
        // This is the error
        return callback(messageBody.Message);
      }
    },
  });
}

function getSignedTranscribeWebsocketUrl(access_id, secret_key) {
  const endpoint = "transcribestreaming.us-east-1.amazonaws.com:8443";

  // get a preauthenticated URL that we can use to establish our WebSocket
  return v4.createPresignedURL(
    "GET",
    endpoint,
    "/medical-stream-transcription-websocket",
    // '/stream-transcription-websocket',
    "transcribe",
    crypto.createHash("sha256").update("", "utf8").digest("hex"),
    {
      key: access_id,
      secret: secret_key,
      protocol: "wss",
      expires: 15,
      region: "us-east-1",
      query:
        "language-code=en-US&media-encoding=pcm&sample-rate=16000&specialty=PRIMARYCARE&type=DICTATION",
    }
  );
}

class AmazonTranscribeService extends EventEmitter {
  constructor(pcmStream, access_id, secret_key) {
    super();
    const awsUrl = getSignedTranscribeWebsocketUrl(access_id, secret_key);
    const awsWsStream = websocket(awsUrl, {
      binaryType: "arraybuffer",
    });
    this.audioEventMessageTransformer = getAudioEventMessageTransformer();
    this.awsEventTransformerStream = getAwsEventTransformerStream();
    pcmStream
      .pipe(this.audioEventMessageTransformer)
      .pipe(awsWsStream)
      .pipe(this.awsEventTransformerStream);

    this.awsEventTransformerStream.on("data", (data) => {
      const transcription = data.toString("utf8");
      this.emit("transcription", transcription);
    });
  }

  stop() {
    console.log("Closing, sending empty buffer to Transcribe");
    this.audioEventMessageTransformer.write(Buffer.from([]));
  }
}

module.exports = AmazonTranscribeService;
