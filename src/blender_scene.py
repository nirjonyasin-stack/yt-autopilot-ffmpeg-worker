import bpy, json, math, sys, os
from mathutils import Vector

args = sys.argv[sys.argv.index("--") + 1:]
spec_path, output_path = args[0], args[1]
with open(spec_path, "r", encoding="utf-8") as f:
    spec = json.load(f)
scenes = spec.get("scenes") or [{"duration_seconds": 6, "visual_description": spec.get("title", "Fun Shapes")}]
width, height = int(spec["width"]), int(spec["height"])
fps = int(spec.get("fps", 24))
bpy.ops.object.select_all(action="SELECT"); bpy.ops.object.delete(use_global=False)
scene = bpy.context.scene
scene.render.engine = "BLENDER_EEVEE_NEXT"
scene.eevee.taa_render_samples = 16
scene.render.resolution_x = width; scene.render.resolution_y = height; scene.render.resolution_percentage = 100
scene.render.fps = fps
scene.render.image_settings.file_format = "FFMPEG"
scene.render.ffmpeg.format = "MPEG4"; scene.render.ffmpeg.codec = "H264"; scene.render.ffmpeg.constant_rate_factor = "MEDIUM"; scene.render.ffmpeg.ffmpeg_preset = "GOOD"
scene.render.filepath = output_path
scene.world.color = (0.08, 0.12, 0.22)
scene.view_settings.view_transform = "Standard"
scene.view_settings.look = "Medium High Contrast"
def mat(name, color, rough=0.55):
    m=bpy.data.materials.new(name); m.diffuse_color=(*color,1); m.use_nodes=True
    bs=m.node_tree.nodes.get("Principled BSDF"); bs.inputs["Base Color"].default_value=(*color,1); bs.inputs["Roughness"].default_value=rough
    return m
palette=[(1,.24,.35),(.12,.72,1),(.98,.72,.12),(.28,.85,.48),(.7,.38,1),(.98,.48,.16)]
mats=[mat("Candy "+str(i),c) for i,c in enumerate(palette)]
white=mat("Soft White",(.96,.97,1)); dark=mat("Deep Navy",(.025,.045,.09)); skin=mat("Warm Peach",(1,.62,.42)); blue=mat("Hero Blue",(.12,.55,.95))
def smooth(obj):
    if obj.type=="MESH":
        for p in obj.data.polygons:p.use_smooth=True
def sphere(name, loc, scale, material, parent=None):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=24, ring_count=16, location=loc)
    o=bpy.context.object;o.name=name;o.scale=scale;o.data.materials.append(material);smooth(o)
    if parent:o.parent=parent
    return o
def cube(name, loc, scale, material, bevel=.12, parent=None):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc);o=bpy.context.object;o.name=name;o.dimensions=scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True);o.data.materials.append(material)
    if bevel:
        mod=o.modifiers.new("Soft rounded edges","BEVEL");mod.width=bevel;mod.segments=4
        o.modifiers.new("Weighted normals","WEIGHTED_NORMAL")
    if parent:o.parent=parent
    return o
def cylinder_between(name, a, b, radius, material, parent=None):
    mid=(Vector(a)+Vector(b))/2; direction=Vector(b)-Vector(a)
    bpy.ops.mesh.primitive_cylinder_add(vertices=16, radius=radius, depth=direction.length, location=mid)
    o=bpy.context.object;o.name=name;o.rotation_mode="QUATERNION";o.rotation_quaternion=direction.to_track_quat("Z","Y");o.data.materials.append(material);smooth(o)
    if parent:o.parent=parent
    return o
# stage
floor=cube("Pastel stage",(0,0,-.25),(15,13,.5),mat("Lavender floor",(.25,.22,.48)),.3)
# camera
bpy.ops.object.camera_add(location=(0,-18,7))
cam=bpy.context.object;cam.data.type="ORTHO";cam.data.ortho_scale=10 if width<height else 14
cam.rotation_euler=(Vector((0,0,2.1))-cam.location).to_track_quat("-Z","Y").to_euler()
scene.camera=cam
# lighting
for loc,power,size in [((-6,-8,11),1500,7),((7,-2,8),1000,6),((0,5,9),1200,5)]:
    bpy.ops.object.light_add(type="AREA", location=loc);l=bpy.context.object;l.data.energy=power;l.data.shape="DISK";l.data.size=size;l.rotation_euler=(Vector((0,0,1))-l.location).to_track_quat("-Z","Y").to_euler()
# friendly original 3D mascot
root=bpy.data.objects.new("Original mascot motion rig",None);scene.collection.objects.link(root)
sphere("Mascot head",(0,0,3.25),(0.82,.62,.82),skin,root)
sphere("Mascot body",(0,0,2.05),(.62,.42,.78),blue,root)
for x in [-.28,.28]:
    sphere("Eye",(x,-.57,3.38),(.105,.07,.15),dark,root)
    sphere("Eye sparkle",(x-.025,-.635,3.43),(.035,.025,.045),white,root)
# smile as tiny curved line using curve bevel
curve=bpy.data.curves.new("Happy smile","CURVE");curve.dimensions="3D";curve.bevel_depth=.035;curve.bevel_resolution=3
sp=curve.splines.new("POLY");sp.points.add(8)
for i,p in enumerate(sp.points):
    x=-.23+i*.0575; z=3.08+.10*(1-(x/.23)**2);p.co=(x,-.625,z,1)
sm=bpy.data.objects.new("Smile",curve);scene.collection.objects.link(sm);sm.data.materials.append(dark);sm.parent=root
# arms and legs
cylinder_between("Left arm",(-.52,0,2.45),(-1.05,0,2.0),.14,skin,root)
cylinder_between("Right arm",(.52,0,2.45),(1.05,0,2.0),.14,skin,root)
sphere("Left hand",(-1.05,0,2.0),(.18,.16,.18),skin,root);sphere("Right hand",(1.05,0,2.0),(.18,.16,.18),skin,root)
cylinder_between("Left leg",(-.3,0,1.45),(-.42,0,.9),.16,blue,root)
cylinder_between("Right leg",(.3,0,1.45),(.42,0,.9),.16,blue,root)
sphere("Left shoe",(-.48,-.05,.82),(.32,.42,.18),mats[0],root);sphere("Right shoe",(.48,-.05,.82),(.32,.42,.18),mats[2],root)
# colorful floating 3D shapes
props=[]
for i in range(6):
    x=(-4.2 + i*1.65); z=2.5+(i%2)*1.35
    if i%3==0:
        bpy.ops.mesh.primitive_uv_sphere_add(segments=24,ring_count=16,location=(x,0,z));o=bpy.context.object;o.name="Floating 3D sphere"
    elif i%3==1:
        bpy.ops.mesh.primitive_cube_add(size=1,location=(x,0,z));o=bpy.context.object;o.name="Floating rounded cube";o.modifiers.new("Rounded","BEVEL").width=.18
    else:
        bpy.ops.mesh.primitive_cone_add(vertices=32,radius1=.55,radius2=0,depth=1.1,location=(x,0,z));o=bpy.context.object;o.name="Floating cone"
    o.data.materials.append(mats[i%len(mats)]);smooth(o);props.append(o)
# title text object in 3D space
font=bpy.data.curves.new("Scene title","FONT");font.body="";font.align_x="CENTER";font.size=.52;font.extrude=.012
title=bpy.data.objects.new("3D scene title",font);scene.collection.objects.link(title);title.location=(0,-.9,5.35);title.rotation_euler=(math.radians(90),0,0);title.data.materials.append(white)
# per-scene camera/mascot animation; each storyboard beat gets a new title and prop motion
frame=1
for si,item in enumerate(scenes):
    duration=max(2.0,float(item.get("duration_seconds",5) or 5)); count=max(1,round(duration*fps)); start=frame; end=frame+count
    text=str(item.get("on_screen_text") or item.get("visual_description") or spec.get("title","Let's play!"))
    title.data.body=text[:52]
    title.scale=(.001,.001,.001);title.keyframe_insert(data_path="scale",frame=start)
    title.scale=(1,1,1);title.keyframe_insert(data_path="scale",frame=min(start+12,end))
    title.scale=(1,1,1);title.keyframe_insert(data_path="scale",frame=max(start+12,end-8))
    title.scale=(.001,.001,.001);title.keyframe_insert(data_path="scale",frame=end)
    for obj in props:
        obj.location.z += .15*(si%2)
        obj.rotation_euler=(0,0,0);obj.keyframe_insert(data_path="rotation_euler",frame=start)
        obj.rotation_euler=(.25,.35,math.tau);obj.keyframe_insert(data_path="rotation_euler",frame=end)
        obj.keyframe_insert(data_path="location",frame=start)
        obj.location.z += .35;obj.keyframe_insert(data_path="location",frame=(start+end)//2)
        obj.location.z -= .35;obj.keyframe_insert(data_path="location",frame=end)
    root.location.z=0;root.keyframe_insert(data_path="location",frame=start)
    root.location.z=.45;root.keyframe_insert(data_path="location",frame=start+max(1,count//4))
    root.location.z=0;root.keyframe_insert(data_path="location",frame=start+max(2,count//2))
    root.location.z=.25;root.keyframe_insert(data_path="location",frame=end)
    root.rotation_euler.z=0;root.keyframe_insert(data_path="rotation_euler",frame=start)
    root.rotation_euler.z=.12 if si%2==0 else -.12;root.keyframe_insert(data_path="rotation_euler",frame=end)
    frame=end+1
scene.frame_start=1;scene.frame_end=frame-1
# smooth keyframe interpolation
for obj in bpy.data.objects:
    if obj.animation_data and obj.animation_data.action:
        for fc in obj.animation_data.action.fcurves:
            for kp in fc.keyframe_points:kp.interpolation="BEZIER"
scene.render.filepath=output_path
bpy.ops.render.render(animation=True)
print("3D animation rendered:",output_path)
