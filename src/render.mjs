import { createClient } from "@supabase/supabase-js";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const supabaseUrl = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const jobId = process.env.VIDEO_JOB_ID;

if (!supabaseUrl || !serviceKey || !jobId) {
  throw new Error("Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or VIDEO_JOB_ID");
}

const supabase = createClient(supabaseUrl, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});
const bucket = "video-audio";
const workDir = path.join(os.tmpdir(), `yt-render-${jobId}`);

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`)));
  });
}

async function setJob(patch) {
  const { error } = await supabase.from("video_jobs").update(patch).eq("id", jobId);
  if (error) throw error;
}

async function signedDownload(storagePath, destination) {
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(storagePath, 900);
  if (error) throw error;
  const response = await fetch(data.signedUrl);
  if (!response.ok) throw new Error(`Asset download failed (${response.status}): ${storagePath}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  await writeFile(destination, bytes);
}

async function main() {
  await mkdir(workDir, { recursive: true });
  const { data: job, error: jobError } = await supabase
    .from("video_jobs").select("*").eq("id", jobId).single();
  if (jobError) throw jobError;
  if (!job) throw new Error("Video job not found");

  await setJob({ status: "rendering", error_message: null });

  const { data: assets, error: assetsError } = await supabase
    .from("video_assets").select("*").eq("job_id", jobId);
  if (assetsError) throw assetsError;

  const images = (assets || []).filter(a =>
    ["image", "thumbnail"].includes(String(a.asset_type).toLowerCase()) && a.storage_path
  );
  const audioAssets = (assets || []).filter(a =>
    a.asset_type === "audio" && a.storage_path
  );

  const imagePaths = [];
  for (let i = 0; i < images.length; i++) {
    const ext = path.extname(images[i].storage_path) || ".jpg";
    const local = path.join(workDir, `scene-${String(i).padStart(3, "0")}${ext}`);
    await signedDownload(images[i].storage_path, local);
    imagePaths.push(local);
  }

  const audioPath = audioAssets.length
    ? path.join(workDir, "voiceover.mp3")
    : null;
  if (audioPath) await signedDownload(audioAssets[0].storage_path, audioPath);

  const output = path.join(workDir, "render.mp4");
  const width = job.format === "short" ? 1080 : 1920;
  const height = job.format === "short" ? 1920 : 1080;
  const secondsPerScene = Math.max(3, Math.min(8, Number(job.duration_seconds || 30) / Math.max(1, imagePaths.length)));
  const args = ["-y"];

  if (imagePaths.length) {
    for (const image of imagePaths) args.push("-loop", "1", "-t", String(secondsPerScene), "-i", image);
    if (audioPath) args.push("-i", audioPath);
    const filters = imagePaths.map((_, i) =>
      `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v${i}]`
    );
    const concatInputs = imagePaths.map((_, i) => `[v${i}]`).join("");
    filters.push(`${concatInputs}concat=n=${imagePaths.length}:v=1:a=0[vout]`);
    args.push("-filter_complex", filters.join(";"), "-map", "[vout]");
    if (audioPath) args.push("-map", `${imagePaths.length}:a:0`, "-shortest");
  } else {
    // Safe fallback: create a simple branded-color background if no scene images exist.
    args.push("-f", "lavfi", "-i", `color=c=0x171923:s=${width}x${height}:r=30:d=${Math.max(5, Number(job.duration_seconds || 15))}`);
    if (audioPath) args.push("-i", audioPath, "-map", "0:v:0", "-map", "1:a:0", "-shortest");
  }

  args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "23");
  if (audioPath) args.push("-c:a", "aac", "-b:a", "192k");
  args.push("-movflags", "+faststart", "-pix_fmt", "yuv420p", output);
  await run("ffmpeg", args);

  const file = await readFile(output);
  const storagePath = `renders/${job.owner_id || "users"}/${jobId}.mp4`;
  const { error: uploadError } = await supabase.storage.from(bucket).upload(storagePath, file, {
    contentType: "video/mp4",
    upsert: true
  });
  if (uploadError) throw uploadError;

  const { error: assetError } = await supabase.from("video_assets").insert({
    job_id: jobId,
    asset_type: "render",
    storage_path: storagePath,
    metadata: { format: "mp4", renderer: "github-actions-ffmpeg" }
  });
  if (assetError) throw assetError;

  const { error: updateError } = await supabase.from("video_jobs").update({
    status: "completed",
    video_path: storagePath,
    error_message: null,
    provider_metadata: {
      ...(job.provider_metadata || {}),
      render: { provider: "github-actions-ffmpeg", storage_path: storagePath, format: "mp4" }
    }
  }).eq("id", jobId);
  if (updateError) throw updateError;

  console.log(`Render complete: ${storagePath}`);
  await rm(workDir, { recursive: true, force: true });
}

main().catch(async error => {
  console.error(error);
  try {
    await setJob({ status: "failed", error_message: String(error.message || error).slice(0, 1000) });
  } catch (updateError) {
    console.error("Could not update failed job status:", updateError);
  }
  process.exitCode = 1;
});
