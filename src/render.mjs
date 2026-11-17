import { createClient } from "@supabase/supabase-js";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {auth:{persistSession:false,autoRefreshToken:false}});
const jobId = process.env.VIDEO_JOB_ID;
const bucket = "video-audio";
const workDir = path.join(os.tmpdir(), "yt-render-" + jobId);
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !jobId) throw new Error("Missing render environment variables");

const run=(cmd,args)=>new Promise((resolve,reject)=>{const p=spawn(cmd,args,{stdio:["ignore","inherit","inherit"]});p.on("error",reject);p.on("close",c=>c===0?resolve():reject(new Error(cmd+" exited "+c)))});
const esc=(s)=>String(s??"").replace(/\\/g,"\\\\").replace(/:/g,"\\:").replace(/'/g,"\\'").replace(/%/g,"\\%").replace(/,/g,"\\,").replace(/\[/g,"\\[").replace(/\]/g,"\\]").replace(/;/g,"\\;");
async function updateJob(patch){const {error}=await supabase.from("video_jobs").update(patch).eq("id",jobId);if(error)throw error;}
async function download(storagePath,dest){storagePath=String(storagePath).replace(/^video-audio\//,"");const {data,error}=await supabase.storage.from(bucket).createSignedUrl(storagePath,900);if(error)throw error;const r=await fetch(data.signedUrl);if(!r.ok)throw new Error("Download failed "+r.status+" for "+storagePath);await writeFile(dest,new Uint8Array(await r.arrayBuffer()));}
function srtTime(t){const ms=Math.max(0,Math.round(t*1000)),h=Math.floor(ms/3600000),m=Math.floor(ms%3600000/60000),s=Math.floor(ms%60000/1000),z=ms%1000;return String(h).padStart(2,"0")+":"+String(m).padStart(2,"0")+":"+String(s).padStart(2,"0")+","+String(z).padStart(3,"0");}
async function main(){
 await mkdir(workDir,{recursive:true});
 const {data:job,error}=await supabase.from("video_jobs").select("*").eq("id",jobId).single();if(error||!job)throw error||new Error("Job not found");
 await updateJob({status:"rendering",error_message:null});
 const {data:assets,error:ae}=await supabase.from("video_assets").select("*").eq("job_id",jobId);if(ae)throw ae;
 const meta=job.provider_metadata||{},story=meta.storyboard||{},storyScenes=Array.isArray(story.scenes)?story.scenes:[];
 const imageAssets=(assets||[]).filter(a=>a.asset_type==="image"&&a.storage_path).sort((a,b)=>(a.metadata?.scene_index??0)-(b.metadata?.scene_index??0));
 const audioAsset=(assets||[]).find(a=>a.asset_type==="audio"&&a.storage_path&&a.metadata?.role!=="background_music")||(assets||[]).find(a=>a.asset_type==="audio"&&a.storage_path);
 const imageFiles=[];
 for(let i=0;i<imageAssets.length;i++){const f=path.join(workDir,"image-"+i+".jpg");await download(imageAssets[i].storage_path,f);imageFiles.push(f);}
 const audioPath=audioAsset?path.join(workDir,"voice.mp3"):null;if(audioPath)await download(audioAsset.storage_path,audioPath);
 const width=job.format==="short"?1080:1920,height=job.format==="short"?1920:1080;
 const defaultDuration=job.format==="short"?45:180;
 const scenes=storyScenes.length?storyScenes:(imageFiles.length?imageFiles.map((_,i)=>({duration_seconds:5,visual_description:"Scene "+(i+1),on_screen_text:"",narration:""})):[{duration_seconds:defaultDuration,visual_description:job.title,on_screen_text:job.title,narration:job.narration_text||job.script||""}]);
 const total=audioPath?Math.max(defaultDuration,Number(job.duration_seconds||0)):scenes.reduce((n,s)=>n+Math.max(2,Number(s.duration_seconds||5)),0);
 const per=scenes.map(s=>Math.max(2,Number(s.duration_seconds||5)));
 const sum=per.reduce((a,b)=>a+b,0),scale=total/sum;
 let cursor=0,subIndex=1,srt="";
 for(let i=0;i<scenes.length;i++){const d=per[i]*scale,txt=String(scenes[i].narration||scenes[i].on_screen_text||"").trim();if(txt){srt+=subIndex+++"\n"+srtTime(cursor)+" --> "+srtTime(cursor+d)+"\n"+txt+"\n\n";}cursor+=d;}
 const srtPath=path.join(workDir,"captions.srt");await writeFile(srtPath,srt||"1\n00:00:00,000 --> 00:00:04,000\n"+String(job.title||"").replace(/\n/g," ")+"\n");
 const inputs=["-y"],filters=[],concat=[];let inputIndex=0;
 for(let i=0;i<scenes.length;i++){
  const d=per[i]*scale;
  if(imageFiles[i]){inputs.push("-loop","1","-t",String(d),"-i",imageFiles[i]);filters.push("["+inputIndex+":v]scale="+width+":"+height+":force_original_aspect_ratio=increase,crop="+width+":"+height+",zoompan=z='min(zoom+0.0008,1.08)':d="+Math.ceil(d*30)+":s="+width+"x"+height+":fps=30,setsar=1,format=yuv420p[v"+i+"]");}
  else {const bg=["0x15243b","0x1b2942","0x202b45","0x162f43"][i%4];inputs.push("-f","lavfi","-t",String(d),"-i","color=c="+bg+":s="+width+"x"+height+":r=30");const idx=inputIndex;inputIndex++;const caption=esc(scenes[i].visual_description||scenes[i].on_screen_text||job.title);filters.push("["+idx+":v]drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='"+caption+"':fontcolor=white:fontsize="+Math.round(width*.055)+":x=(w-text_w)/2:y=(h-text_h)/2:box=1:boxcolor=black@0.25:boxborderw=24,format=yuv420p[v"+i+"]");}
  concat.push("[v"+i+"]");
 }
 const audioIndex=inputIndex;
 if(audioPath)inputs.push("-i",audioPath);
 const output=path.join(workDir,"render.mp4");
 const filter=filters.join(";")+ ";" + concat.join("")+"concat=n="+scenes.length+":v=1:a=0,subtitles='"+srtPath.replace(/\\/g,"/")+"':force_style='FontName=DejaVu Sans,FontSize="+(job.format==="short"?22:30)+",Outline=2,Shadow=1,Alignment=2,MarginV=80'[vout]";
 inputs.push("-filter_complex",filter,"-map","[vout]");
 if(audioPath)inputs.push("-map",audioIndex+":a:0","-shortest","-c:a","aac","-b:a","192k");
 inputs.push("-c:v","libx264","-preset","veryfast","-crf","22","-pix_fmt","yuv420p","-movflags","+faststart",output);
 await run("ffmpeg",inputs);
 const videoPath="renders/"+job.owner_id+"/"+jobId+".mp4";
 const {error:up}=await supabase.storage.from(bucket).upload(videoPath,await readFile(output),{contentType:"video/mp4",upsert:true});if(up)throw up;
 const thumb=path.join(workDir,"thumbnail.jpg");
 const title=esc(story.thumbnail?.text||job.title||"New Video");
 await run("ffmpeg",["-y","-f","lavfi","-i","color=c=0x15243b:s=1280x720","-vf","drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='"+title+"':fontcolor=white:fontsize=64:x=(w-text_w)/2:y=(h-text_h)/2:box=1:boxcolor=0x000000@0.35:boxborderw=30","-frames:v","1",thumb]);
 const thumbPath="thumbnails/"+job.owner_id+"/"+jobId+".jpg";
 const {error:tu}=await supabase.storage.from(bucket).upload(thumbPath,await readFile(thumb),{contentType:"image/jpeg",upsert:true});if(tu)throw tu;
 const captionPath="captions/"+job.owner_id+"/"+jobId+".srt";
 const {error:cu}=await supabase.storage.from(bucket).upload(captionPath,await readFile(srtPath),{contentType:"application/x-subrip",upsert:true});if(cu)throw cu;
 const {error:assetErr}=await supabase.from("video_assets").insert([
  {owner_id:job.owner_id,job_id:jobId,asset_type:"render",storage_path:videoPath,metadata:{format:"mp4",renderer:"github-actions-ffmpeg",captions:captionPath,thumbnail:thumbPath}},
  {owner_id:job.owner_id,job_id:jobId,asset_type:"thumbnail",storage_path:thumbPath,metadata:{format:"jpg",generated:true}},
  {owner_id:job.owner_id,job_id:jobId,asset_type:"subtitle",storage_path:captionPath,metadata:{format:"srt",generated:true}}
 ]);if(assetErr)throw assetErr;
 const {error:finalErr}=await supabase.from("video_jobs").update({status:"completed",video_path:videoPath,thumbnail_path:thumbPath,captions:srt,error_message:null,provider_metadata:{...meta,render:{provider:"github-actions-ffmpeg",storage_path:videoPath,thumbnail_path:thumbPath,captions_path:captionPath,format:"mp4",storyboard_scenes:scenes.length}}}).eq("id",jobId);if(finalErr)throw finalErr;
 console.log("Render complete",videoPath,thumbPath,captionPath);
 await rm(workDir,{recursive:true,force:true});
}
main().catch(async e=>{console.error(e);try{await updateJob({status:"failed",error_message:String(e.message||e).slice(0,1000)});}catch(x){console.error(x)}process.exitCode=1;});