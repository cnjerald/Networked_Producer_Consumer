// Readme?
// Install Requirements
// npm install express express-handlebars @grpc/grpc-js @grpc/proto-loader
// Start server
// npm start
// --- Imports ---
const express = require('express');
const { engine } = require('express-handlebars');
const path = require('path');
const fs = require('fs');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');

// --- Constants ---
const PROTO_PATH = path.join(__dirname, 'proto/media.proto');
const VIDEO_DIR = path.join(__dirname, 'videos');
const CONSUMER_ADDRESS = 'localhost:50052'; // Change to consumer VM IP later
const HTTP_PORT = 5001; // different from consumer's 5000

// --- Express Setup ---
const app = express();
app.engine('hbs', engine({ extname: '.hbs' }));
app.set('view engine', 'hbs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static('public'));

// --- gRPC Setup ---
const packageDef = protoLoader.loadSync(PROTO_PATH);
const mediaProto = grpc.loadPackageDefinition(packageDef).media;
const client = new mediaProto.MediaUpload(
  CONSUMER_ADDRESS,
  grpc.credentials.createInsecure()
);

// --- This function uploads a video based on the path defined by the user
function uploadVideo(filePath) {
  // Async function
  return new Promise((resolve, reject) => {
    // Client is the consume
    const call = client.UploadVideo((err, response) => {
      if (err) reject(err);
      else resolve(response);
    });
    // Steam splits it to 1MB chunks
    const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 }); // 1MB chunks
    // For each chunk, send it to the consumer
    stream.on('data', (chunk) => {
      call.write({ filename: path.basename(filePath), chunk });
    });
    // Terminate the stream once end is reached
    stream.on('end', () => {
      call.end();
    });
  });
}

// This is the index, it just reads the list of available videos that can be sent.
app.get('/', async (req, res) => {
  const files = fs.readdirSync(VIDEO_DIR).filter(f => f.endsWith('.mp4'));
  res.render('home', { title: 'Producer', files });
});

// This url uses the uploadVideo() Function
app.post('/send/:filename', async (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(__dirname, 'videos', filename);

  try {
    const response = await uploadVideo(filePath);
    res.status(200).send(`File ${filename} uploaded successfully`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Upload failed');
  }
});


// --- Start the server ---
app.listen(HTTP_PORT, () => {
  console.log(` Producer running at http://localhost:${HTTP_PORT}`);
});
