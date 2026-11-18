import { createClient } from "@supabase/supabase-js";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const supabase=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
const jobId=process.env.VIDEO_JOB_ID,bucket="video-audio",workDir=path.join(os.tmpdir(),"yt-render-"+jobId);
if(!process.env.SUPABASE_URL||!process.env.SUPABASE_SERVICE_ROLE_KEY||!jobId)throw new Error("Missing render environment variables");
const run=(cmd,args)=>new Promise((resolve,reject)=>{const p=spawn(cmd,args,{stdio:["ignore","inherit","inherit"]});p.on("error",reject);p.on("close",c=>c===0?resolve():reject(new Error(cmd+" exited "+c)))});
async function updateJob(patch){const {error}=await supabase.from("video_jobs").update(patch).eq("id",jobId);if(error)throw error;}
async function download(storagePath,dest){storagePath=String(storagePath).replace(/^video-audio\//,"");const {data,error}=await supabase.storage.from(bucket).createSignedUrl(storagePath,900);if(error)throw error;const r=await fetch(data.signedUrl);if(!r.ok)throw new Error("Download failed "+r.status+" for "+storagePath);await writeFile(dest,new Uint8Array(await r.arrayBuffer()));}
const srtTime=t=>{const ms=Math.max(0,Math.round(t*1000)),h=Math.floor(ms/3600000),m=Math.floor(ms%3600000/60000),s=Math.floor(ms%60000/1000),z=ms%1000;return String(h).padStart(2,"0")+":"+String(m).padStart(2,"0")+":"+String(s).padStart(2,"0")+","+String(z).padStart(3,"0")};
async function main(){
 await mkdir(workDir,{recursive:true});
 const {data:job,error}=await supabase.from("video_jobs").select("*").eq("id",jobId).single();if(error||!job)throw error||new Error("Job not found");
 await updateJob({status:"rendering",error_message:null});
 const {data:assets,error:ae}=await supabase.from("video_assets").select("*").eq("job_id",jobId);if(ae)throw ae;
 const meta=job.provider_metadata||{},story=meta.storyboard||{},storyScenes=Array.isArray(story.scenes)?story.scenes:[];
 const audioAsset=(assets||[]).find(a=>a.asset_type==="audio"&&a.storage_path&&a.metadata?.role!=="background_music")||(assets||[]).find(a=>a.asset_type==="audio"&&a.storage_path);
 let audioPath=audioAsset?path.join(workDir,"voice-audio"):null;
 if(audioPath)await download(audioAsset.storage_path,audioPath);
 else{
  const narration=storyScenes.map(s=>String(s.narration||"").trim()).filter(Boolean).join("\n\n")||String(job.narration_text||job.script||"").trim();
  if(narration){
   const textPath=path.join(workDir,"narration.txt");audioPath=path.join(workDir,"kokoro-voice.wav");await writeFile(textPath,narration,"utf8");
   await run("python",[ "src/kokoro_tts.py",textPath,audioPath,path.join(os.homedir(),".cache/kokoro/kokoro-v1.0.onnx"),path.join(os.homedir(),".cache/kokoro/voices-v1.0.bin") ]);
   const voicePath="voiceovers/"+job.owner_id+"/"+jobId+"/kokoro-voice.wav";
   const {error:ue}=await supabase.storage.from(bucket).upload(voicePath,await readFile(audioPath),{contentType:"audio/wav",upsert:true});if(ue)throw ue;
   const {error:ie}=await supabase.from("video_assets").insert([{owner_id:job.owner_id,job_id:jobId,asset_type:"audio",storage_path:voicePath,metadata:{role:"voiceover",provider:"kokoro-onnx",voice:"af_sarah"}}]);if(ie)throw ie;
  }
 }
 const width=job.format==="short"?540:960,height=job.format==="short"?960:540,fps=24;
 const scenes=storyScenes.length?storyScenes:[{duration_seconds:job.format==="short"?45:120,visual_description:job.title,on_screen_text:job.title,narration:job.narration_text||job.script||""}];
 const sceneData=scenes.map((s,i)=>({duration_seconds:Math.max(3,Number(s.duration_seconds||6)),visual_description:String(s.visual_description||s.on_screen_text||("Colorful 3D scene "+(i+1))),on_screen_text:String(s.on_screen_text||s.visual_description||""),narration:String(s.narration||"")}));
 let cursor=0,captionIndex=1,srt="";
 for(const s of sceneData){const d=s.duration_seconds,txt=(s.narration||s.on_screen_text).trim();if(txt)srt+=captionIndex+++"\n"+srtTime(cursor)+" --> "+srtTime(cursor+d)+"\n"+txt+"\n\n";cursor+=d;}
 const srtPath=path.join(workDir,"captions.srt");await writeFile(srtPath,srt||"1\n00:00:00,000 --> 00:00:04,000\n"+String(job.title||"").replace(/\n/g," ")+"\n","utf8");
 const specPath=path.join(workDir,"story.json"),raw3d=path.join(workDir,"animation.mp4"),output=path.join(workDir,"render.mp4");
 await writeFile(specPath,JSON.stringify({title:job.title,width,height,fps,scenes:sceneData}),"utf8");
 await run("blender",["-b","-t","2","-P","src/blender_scene.py","--",specPath,raw3d]);
 const subFilter="subtitles='"+srtPath.replace(/\\/g,"/").replace(/:/g,"\\:")+"':force_style='FontName=DejaVu Sans,FontSize="+(job.format==="short"?18:24)+",Outline=2,Shadow=1,Alignment=2,MarginV=42'";
 const args=["-y","-i",raw3d,"-vf",subFilter];
 if(audioPath)args.push("-i",audioPath,"-map","0:v:0","-map","1:a:0","-shortest","-c:a","aac","-b:a","160k");
 else args.push("-an");
 args.push("-c:v","libx264","-preset","veryfast","-crf","23","-pix_fmt","yuv420p","-movflags","+faststart",output);
 await run("ffmpeg",args);
 const videoPath="renders/"+job.owner_id+"/"+jobId+".mp4";
 const {error:up}=await supabase.storage.from(bucket).upload(videoPath,await readFile(output),{contentType:"video/mp4",upsert:true});if(up)throw up;
 const thumb=path.join(workDir,"thumbnail.jpg");await run("ffmpeg",["-y","-i",raw3d,"-frames:v","1",thumb]);
 const thumbPath="thumbnails/"+job.owner_id+"/"+jobId+".jpg";
 const {error:tu}=await supabase.storage.from(bucket).upload(thumbPath,await readFile(thumb),{contentType:"image/jpeg",upsert:true});if(tu)throw tu;
 const captionPath="captions/"+job.owner_id+"/"+jobId+".srt";
 const {error:cu}=await supabase.storage.from(bucket).upload(captionPath,await readFile(srtPath),{contentType:"application/x-subrip",upsert:true});if(cu)throw cu;
 const {error:assetErr}=await supabase.from("video_assets").insert([
  {owner_id:job.owner_id,job_id:jobId,asset_type:"render",storage_path:videoPath,metadata:{format:"mp4",renderer:"blender-3d+ffmpeg",captions:captionPath,thumbnail:thumbPath}},
  {owner_id:job.owner_id,job_id:jobId,asset_type:"thumbnail",storage_path:thumbPath,metadata:{format:"jpg",generated:true}},
  {owner_id:job.owner_id,job_id:jobId,asset_type:"subtitle",storage_path:captionPath,metadata:{format:"srt",generated:true}}
 ]);if(assetErr)throw assetErr;
 const {error:fe}=await supabase.from("video_jobs").update({status:"completed",video_path:videoPath,thumbnail_path:thumbPath,captions:srt,error_message:null,provider_metadata:{...meta,render:{provider:"blender-3d+ffmpeg",storage_path:videoPath,thumbnail_path:thumbPath,captions_path:captionPath,format:"mp4",storyboard_scenes:sceneData.length,resolution:width+"x"+height}}}).eq("id",jobId);if(fe)throw fe;
 console.log("3D render complete",videoPath);
 await rm(workDir,{recursive:true,force:true});
}
main().catch(async e=>{console.error(e);try{await updateJob({status:"failed",error_message:String(e.message||e).slice(0,1000)});}catch(x){console.error(x)}process.exitCode=1;});
