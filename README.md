# YT Autopilot FFmpeg Render Worker

On-demand GitHub Actions worker that uses FFmpeg to create an MP4 from scene images and an optional voice track stored in the private Supabase Storage bucket `video-audio`.

## Configure repository secrets

Open **Settings → Secrets and variables → Actions** and add:

- `SUPABASE_URL`: the Supabase project URL.
- `SUPABASE_SERVICE_ROLE_KEY`: the Supabase service-role secret. Never put this key in browser code or commit it to this repository.

## Run a test render

1. Ensure a valid row exists in `video_jobs`.
2. Add scene images to `video_assets` for that job, with `asset_type=image` and `storage_path` values in the private `video-audio` bucket. An audio asset is optional (`asset_type=audio`).
3. Open **Actions → Render video → Run workflow**.
4. Enter the exact `video_jobs.id` as `job_id`.
5. On success, the MP4 is stored at `renders/<owner_id>/<job_id>.mp4` in `video-audio`, and `video_jobs.video_path` is updated.

## Current renderer scope

- Shorts: 1080×1920; long videos: 1920×1080.
- Scene images are stitched into an MP4 slideshow; the first audio asset is used as the voice track.
- If there are no images, a plain background video is created (with audio if available).
- This initial worker does not yet animate captions, render uploaded video clips, mix background music, or generate scene artwork.

## Important

GitHub Actions is an on-demand worker, not an always-on HTTP server. A server-side caller must dispatch this workflow with a GitHub Actions token and a job ID. Keep that token and the Supabase service-role key in server-side secrets only. GitHub Actions usage is subject to the account's included minutes and limits.
