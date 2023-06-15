import m3u8Parser from "m3u8-parser";
import ffmpegPath from "ffmpeg-static";
import loading from "loading-cli";
import path from "node:path";
import { spawn } from "child_process";
import fs from "node:fs";

const load = loading({
  color: "yellow",
});

export default async function downloadFromPlaylist({
  playlist,
  outPath,
  videoNumber,
}) {
  try {
    load.start(
      `[Apple TV] Getting playlist m3u8 data of trailer ${videoNumber}`
    );
    const playlistResponse = await fetch(playlist);
    let playlistText = await playlistResponse.text();

    playlistText = playlistText.split("\n").slice(0, -1).join("\n");

    const parser = new m3u8Parser.Parser();

    parser.push(playlistText);

    parser.end();

    const playlistJson = parser.manifest.playlists;

    let videoPlaylistM3u8 = playlistJson.find((playlist) => {
      return playlist.attributes.RESOLUTION.width >= 1900;
    });

    if (!videoPlaylistM3u8) {
      videoPlaylistM3u8 = playlistJson.reduce((acc, playlist) => {
        if (
          playlist.attributes.RESOLUTION.width > acc.attributes.RESOLUTION.width
        ) {
          return playlist;
        }
        return acc;
      });
    }

    const audioPlaylistM3u8Language =
      parser.manifest.mediaGroups.AUDIO[videoPlaylistM3u8.attributes.AUDIO];

    let audioPlaylistM3u8 = Object.values(audioPlaylistM3u8Language).find(
      (al) => al.language === "pt-BR"
    );

    if (!audioPlaylistM3u8) {
      audioPlaylistM3u8 =
        audioPlaylistM3u8Language[Object.keys(audioPlaylistM3u8Language)[0]];
    }

    load.succeed(
      `[Apple TV] Playlist m3u8 data of trailer ${videoNumber} found`
    );

    load.start(
      `[Apple TV] Getting audio and video m3u8 data of trailer ${videoNumber}`
    );
    const videoPlaylistResponse = await fetch(videoPlaylistM3u8.uri);
    const audioPlaylistResponse = await fetch(audioPlaylistM3u8.uri);

    const videoPlaylistText = await videoPlaylistResponse.text();
    const audioPlaylistText = await audioPlaylistResponse.text();

    const videoPlaylistParser = new m3u8Parser.Parser();
    const audioPlaylistParser = new m3u8Parser.Parser();

    videoPlaylistParser.push(videoPlaylistText);
    audioPlaylistParser.push(audioPlaylistText);

    videoPlaylistParser.end();
    audioPlaylistParser.end();

    const videoSegments = videoPlaylistParser.manifest.segments;
    const audioSegments = audioPlaylistParser.manifest.segments;

    const videoPartInicialPath = videoSegments[0].map.uri;
    const audioPartInicialPath = audioSegments[0].map.uri;

    const videoPartsPath = [
      videoPartInicialPath,
      ...videoSegments.map((segment) => segment.uri),
    ];
    const audioPartsPath = [
      audioPartInicialPath,
      ...audioSegments.map((segment) => segment.uri),
    ];

    const videoPlaylistM3BaseUrl = videoPlaylistM3u8.uri
      .split("/")
      .slice(0, -1)
      .join("/");
    const audioPlaylistM3BaseUrl = audioPlaylistM3u8.uri
      .split("/")
      .slice(0, -1)
      .join("/");

    const videoPartsUrl = videoPartsPath.map(
      (partPath) => `${videoPlaylistM3BaseUrl}/${partPath}`
    );
    const audioPartsUrl = audioPartsPath.map(
      (partPath) => `${audioPlaylistM3BaseUrl}/${partPath}`
    );

    const tempDir = path.join(process.cwd(), "temp");

    if (!fs.existsSync(tempDir)) {
      console.log("Criando pasta temporária para armazenar os arquivos");
      fs.mkdirSync(tempDir);
    }

    load.succeed(
      `[Apple TV] Audio and video m3u8 data of trailer ${videoNumber} found`
    );

    load.start(
      `[Apple TV] Downloading audio and video of trailer ${videoNumber}`
    );
    let videoBlob = new Blob();
    for (let i = 0; i < videoPartsUrl.length; i++) {
      load.text = `[Apple TV] Downloading video part ${i + 1}/${
        videoPartsUrl.length
      } of trailer ${videoNumber}`;
      const videoPartUrl = videoPartsUrl[i];
      const response = await fetch(videoPartUrl);
      const partBlob = await response.arrayBuffer();
      videoBlob = new Blob([videoBlob, partBlob], { type: "video/mp4" });
    }

    const videoTempPath = path.join(tempDir, `${Date.now()}-video.mp4`);
    await saveBlobFile(videoBlob, videoTempPath);

    load.succeed(`[Apple TV] Video of trailer ${videoNumber} downloaded`);

    load.start(`[Apple TV] Downloading audio of trailer ${videoNumber}`);
    let audioBlob = new Blob();
    for (let i = 0; i < audioPartsUrl.length; i++) {
      load.text = `[Apple TV] Downloading audio part ${i + 1}/${
        audioPartsUrl.length
      } of trailer ${videoNumber}`;
      const audioPartUrl = audioPartsUrl[i];
      const response = await fetch(audioPartUrl);
      const partBlob = await response.arrayBuffer();
      audioBlob = new Blob([audioBlob, partBlob], {
        type: "audio/mpeg",
      });
    }
    const audioTempPath = path.join(tempDir, `${Date.now()}-audio.mp3`);
    await saveBlobFile(audioBlob, audioTempPath);
    load.succeed(`[Apple TV] Audio of trailer ${videoNumber} downloaded`);

    load.start(`[Apple TV] Merging audio and video of trailer ${videoNumber}`);
    const videoFrames = await getTotalVideoFrames(videoTempPath);

    const resultVideoPath = path.join(outPath, `trailer-${videoNumber}.mp4`);
    const ffmpegCommand = `${ffmpegPath} -i ${videoTempPath} -i ${audioTempPath} -c:v copy -c:a aac -strict experimental ${resultVideoPath}`;
    const ffmpegProcess = spawn(ffmpegCommand, { shell: true });

    ffmpegProcess.stderr.on("data", (data) => {
      const logString = data.toString().trim();

      if (!logString.startsWith("frame=")) {
        return;
      }

      const frame = parseInt(logString.split("=")[1].split(" ")[1] || "0");
      const percentage = Math.round((frame / videoFrames) * 100);
      load.text = `[Apple TV] Merging audio and video of trailer ${videoNumber} ${percentage}%`;
    });

    await new Promise((resolve, reject) => {
      ffmpegProcess.on("close", (code) => {
        if (code === 0) {
          resolve();
        }
        reject();
      });
    });

    load.succeed(`[Apple TV] Audio and video of trailer ${videoNumber} merged`);
  } catch (error) {
    load.stop();
    throw error;
  }
}

async function getTotalVideoFrames(videoPath) {
  const command = `${ffmpegPath} -i ${videoPath} -map 0:v:0 -c copy -f null -`;
  const process = spawn(command, { shell: true });
  let totalFrames = 0;
  process.stderr.on("data", (data) => {
    const logString = data.toString().trim();

    if (!logString.startsWith("frame=")) {
      return;
    }

    const frame = parseInt(logString.split("=")[1].split(" ")[1] || "0");
    totalFrames = frame;
  });

  await new Promise((resolve, reject) => {
    process.on("close", (code) => {
      if (code === 0) {
        resolve();
      }
      reject();
    });
  });

  return totalFrames;
}

async function saveBlobFile(blob, output) {
  const arrayBuffer = await blob.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  fs.writeFileSync(output, buffer);
}