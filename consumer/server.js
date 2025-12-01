// Readme?
// Install Libraries to your PC
// npm install express express-handlebars fs-extra @grpc/grpc-js @grpc/proto-loader fluent-ffmpeg ws
// Run the server
// npm start
// You need to install and add ffmpeg to path.
// https://www.gyan.dev/ffmpeg/builds/
// Change ffmpegPath to the correct path.
// Recieved Videos are store on /uploads
const express = require('express');
const { engine } = require('express-handlebars');
const path = require('path');
const fs = require('fs-extra');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = "C:/Users/aljirah/Downloads/ffmpeg-8.0.1-essentials_build/bin/ffmpeg.exe"; // <- change to your actual path
ffmpeg.setFfmpegPath(ffmpegPath);
const WebSocket = require('ws');

// === CONFIG ===
const PROTO_PATH = path.join(__dirname, 'proto/media.proto');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const PREVIEW_DIR = path.join(__dirname, 'previews');
const HTTP_PORT = 5000;
const GRPC_PORT = 50052;

// === Parse command-line arguments ===
const args = Object.fromEntries(process.argv.slice(2).map(a => a.split('=')));
const C = parseInt(args['--c'] || 2);  // number of consumer threads
const Q = parseInt(args['--q'] || 5);  // queue capacity

console.log(`Config: ${C} consumers, queue length = ${Q}`);

// === EXPRESS SETUP ===
const app = express();
app.engine('hbs', engine({ extname: '.hbs' }));
app.set('view engine', 'hbs');
app.set('views', path.join(__dirname, 'views'));

// Serve static folders for videos & previews
app.use('/uploads', express.static(UPLOAD_DIR));
app.use('/previews', express.static(PREVIEW_DIR));

// === Background thread: refresh list every N seconds (optional) ===
let videoList = [];
let previewList = [];
const POLL_INTERVAL_MS = 5000; // 5 seconds

setInterval(() => {
  videoList = fs.readdirSync(UPLOAD_DIR);
  previewList = fs.readdirSync(PREVIEW_DIR);
}, POLL_INTERVAL_MS);

// Index page: render uploaded videos & previews
app.get('/', async (req, res) => {
  res.render('home', {
    title: 'Consumer Dashboard',
    videos: videoList,
    previews: previewList
  });
});

// Get saved videos directories (both videos and previews)
app.get('/api/videos', async (req, res) => {
  try {
    const videos = await fs.readdir(UPLOAD_DIR);
    const previews = await fs.readdir(PREVIEW_DIR);
    res.json({ videos, previews });
  } catch(err) {
    res.status(500).json({ error: 'Failed to read directories' });
  }
});

// start server
app.listen(HTTP_PORT, () => {
  console.log(`Web server running at http://localhost:${HTTP_PORT}`);
});

// === gRPC SETUP ===
const packageDef = protoLoader.loadSync(PROTO_PATH);
const mediaProto = grpc.loadPackageDefinition(packageDef).media;

// === QUEUE + WORKERS ===
const uploadQueue = [];
let activeConsumers = 0;

// Handle downloads
async function processNext() {
  if (activeConsumers >= C || uploadQueue.length === 0) return;

  const task = uploadQueue.shift();
  activeConsumers++;
  console.log(`Processing ${task.filePath} (Active: ${activeConsumers})`);

  try {
    // Generate 10-second preview
    const inputPath = task.filePath;
    const previewPath = path.join(PREVIEW_DIR, `preview-${path.basename(task.filePath)}`);

    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .setStartTime(0)
        .setDuration(10)
        .output(previewPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    console.log(`Finished processing: ${path.basename(task.filePath)}`);
  } catch (err) {
    console.error('Processing failed:', err);
  } finally {
    activeConsumers--;
    processNext();
  }
}

// Enqueue downloads
async function enqueueUpload(filePath) {
  if (uploadQueue.length >= Q) {
    console.log(`Queue full (${Q}). Dropping file ${filePath}`);
    await fs.remove(filePath);
    return;
  }
  uploadQueue.push({ filePath });
  processNext();
}

// === gRPC Service Implementation ===
async function UploadVideo(call, callback) {
  const filename = `upload_${Date.now()}.mp4`;
  const filePath = path.join(UPLOAD_DIR, filename);
  const writeStream = fs.createWriteStream(filePath);

  call.on('data', (chunk) => {
    writeStream.write(chunk.chunk);
  });

  call.on('end', async () => {
    writeStream.end();
    console.log(`Received video: ${filename}`);
    await enqueueUpload(filePath);
    callback(null, { success: true, message: `Queued ${filename}` });
  });
}

const wss = new WebSocket.Server({ port: 8080 });
console.log('WebSocket server running on ws://localhost:8080');

function broadcastProgress(message) {
  const data = JSON.stringify(message);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

// Update gRPC UploadVideo handler to send progress
async function UploadVideo(call, callback) {
  const filename = `upload_${Date.now()}.mp4`;
  const filePath = path.join(UPLOAD_DIR, filename);
  const writeStream = fs.createWriteStream(filePath);

  let uploadedBytes = 0;

  call.on('data', (chunk) => {
    writeStream.write(chunk.chunk);
    uploadedBytes += chunk.chunk.length;

    // Broadcast progress
    broadcastProgress({ filename, uploadedBytes });
  });

  call.on('end', async () => {
    writeStream.end();
    console.log(`Received video: ${filename}`);

    // Enqueue for processing (e.g., 10-sec preview)
    await enqueueUpload(filePath);

    // Broadcast 100% progress
    broadcastProgress({ filename, uploadedBytes, done: true });

    callback(null, { success: true, message: `Queued ${filename}` });
  });
}

// Start gRPC server
const grpcServer = new grpc.Server();
grpcServer.addService(mediaProto.MediaUpload.service, { UploadVideo });

grpcServer.bindAsync(
  `0.0.0.0:${GRPC_PORT}`,
  grpc.ServerCredentials.createInsecure(),
  () => {
    fs.ensureDirSync(UPLOAD_DIR);
    fs.ensureDirSync(PREVIEW_DIR);
    console.log(`gRPC server running on port ${GRPC_PORT}`);
    grpcServer.start();
  }
);
