#!/usr/bin/env python3
"""Sourced Oca footprint, stylized elevation; no photographic pixels exported."""
import bpy, runpy, json, math, hashlib
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
H=runpy.run_path(str(ROOT/'scripts/environment/build_focal_sites.py'))
Batch=H['MeshBatch']; project=H['wgs84_to_world']; sample=H['sample_terrain_height']
OUT=ROOT/'public/village/oca-site'; SOURCE=ROOT/'assets/environment/oca-site/source.json'
def load(p):return json.loads(p.read_text())
def arch(b,x,y,r,spring,top,thick,color,top_profile=None):
    # Actual open arch cutout: radial voussoirs plus solid masonry above arc.
    for i in range(12):
        a=math.pi*i/12; c=math.pi*(i+1)/12
        lo=[(y+r*math.cos(t),spring+r*math.sin(t)) for t in (a,c)]
        hi=[(y+(r+.25)*math.cos(t),spring+(r+.25)*math.sin(t)) for t in (a,c)]
        for xx in (x-thick/2,x+thick/2):
            b.face([(xx,*lo[0]),(xx,*lo[1]),(xx,*hi[1]),(xx,*hi[0])],color)
            cap=lambda p:top_profile(p[0]) if top_profile else top
            b.face([(xx,*hi[0]),(xx,*hi[1]),(xx,hi[1][0],cap(hi[1])),(xx,hi[0][0],cap(hi[0]))],color)
        b.face([(x-thick/2,*lo[0]),(x+thick/2,*lo[0]),(x+thick/2,*lo[1]),(x-thick/2,*lo[1])],color)
def bell(b,x,y,z):
    rings=[]
    for zz,rr in ((z,.39),(z+.10,.34),(z+.55,.18),(z+.68,.11)):
        rings.append([(x+rr*math.cos(i*math.tau/12),y+rr*math.sin(i*math.tau/12),zz) for i in range(12)])
    for a,c in zip(rings,rings[1:]):
        for i in range(12):b.face([a[i],a[(i+1)%12],c[(i+1)%12],c[i]],(.10,.12,.10,1))
    b.box(x,y,z+.9,.18,.85,.32,(.16,.10,.05,1))
def roof_plane(batch, points, color, thickness=.10):
    """Closed roof slab: visible from below as well as above, no paper edge."""
    points=list(points)
    a,c,d=points[:3]
    if (c[0]-a[0])*(d[1]-a[1])-(c[1]-a[1])*(d[0]-a[0])<0:
        points.reverse()
    batch.face(points,color)
    underside=[(x,y,z-thickness)for x,y,z in points]
    batch.face(list(reversed(underside)),tuple(v*.62 for v in color[:3])+(1,))
    for i in range(len(points)):
        j=(i+1)%len(points)
        batch.face([points[i],underside[i],underside[j],points[j]],color)

def ridge_cap(batch, xmin, xmax, y, z, color):
    """Low polygon curved ridge tile, using the existing roofing material."""
    for i in range(6):
        a,c=math.pi*i/6,math.pi*(i+1)/6
        y0,y1=y+.12*math.cos(a),y+.12*math.cos(c)
        z0,z1=z+.12*math.sin(a),z+.12*math.sin(c)
        batch.face([(xmin,y0,z0),(xmax,y0,z0),(xmax,y1,z1),(xmin,y1,z1)],color)

def build():
    OUT.mkdir(parents=True,exist_ok=True);src=load(SOURCE)
    raw=load(ROOT/'assets/environment/oca-site/osm-ermita.json')['elements'];ns={e['id']:e for e in raw if e['type']=='node'};way=next(e for e in raw if e['type']=='way')
    world=[project(ns[n]['lon'],ns[n]['lat'])for n in way['nodes'][:-1]];anchor=H['polygon_centroid'](world)
    pts=[(x-anchor[0],z-anchor[1])for x,z in world];xs=[p[0]for p in pts];ys=[p[1]for p in pts]
    x0,x1=min(xs),max(xs);y0,y1=min(ys),max(ys);ym=(y0+y1)/2
    grids={(x,z):load(ROOT/f'public/terrain/tiles/tile_{x}_{z}.json')['grid']for x in range(6)for z in range(6)};datum=load(ROOT/'public/terrain/config.json')['verticalDatum'];ground=sample(grids,*anchor,datum)
    bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False);col=bpy.data.collections.new('oca-site');bpy.context.scene.collection.children.link(col)
    b=Batch();stone=(.46,.39,.29,1);light=(.58,.50,.38,1);roof=(.33,.105,.035,1)
    # Preserve mapped side/back walls; omit the west-facing narthex facade,
    # whose masonry is rebuilt around the open arch below.
    for i,a in enumerate(pts):
        c=pts[(i+1)%len(pts)]
        if max(a[0],c[0]) < x0+1.0 and abs(c[1]-a[1]) > abs(c[0]-a[0]):
            continue
        # The mapped west notch is the low narthex, not a full nave wall.
        height=3.25 if max(a[0],c[0])<x0+4.1 else 5.1
        b.face([(a[0],a[1],-.3),(c[0],c[1],-.3),
                (c[0],c[1],height),(a[0],a[1],height)],stone)

    # Western espadaña, two physically open bell apertures.
    wallx=x0+4.5
    # Nave roof begins behind the west bell wall, avoiding a front roof wedge.
    nave_start,nave_end=wallx+.36,x1+.25
    for yy in (y0-.2,y1+.2):
        roof_plane(b,[(nave_start,yy,5.2),(nave_end,yy,5.2),
                      (nave_end,ym,6.65),(nave_start,ym,6.65)],roof)
    ridge_cap(b,nave_start,nave_end,ym,6.65,roof)
    b.box(wallx,ym,3.85,.65,y1-y0,8.0,stone)
    r=.67;spring=9.05;top=10.2;centers=[ym-1.23,ym+1.23]
    outer=[y0,y0+.9,ym-.30,ym+.30,y1-.9,y1]
    for a,c in ((y0,centers[0]-r),(centers[0]+r,centers[1]-r),(centers[1]+r,y1)):
        b.box(wallx,(a+c)/2,8.62,.65,c-a,1.84,light)
    for cy in centers:arch(b,wallx,cy,r,spring,top,.65,light);bell(b,wallx,cy,8.05)
    for xx in (wallx-.46,wallx+.46):
        roof_plane(b,[(xx,y0-.1,10.28),(xx,y1+.1,10.28),
                      (wallx,y1+.1,10.45),(wallx,y0-.1,10.45)],roof,.08)
    # West narthex. Piers, true arched entrance, gate bars and gabled porch.
    portalx=x0-.05;rad=1.72
    for cy in (ym-rad-.3,ym+rad+.3):b.box(portalx,cy,1.75,.65,.6,3.5,light)
    profile=lambda yy:4.6-abs(yy-ym)/(rad+.55)*1.35
    arch(b,portalx,ym,rad,2.25,4.35,.48,light,profile)
    for i in range(17):b.box(portalx-.1,ym-rad+.10+i*(2*rad-.20)/16,1.07,.035,.035,2.14,(.055,.055,.05,1))
    b.box(portalx-.1,ym,1.65,.04,3.3,.05,(.055,.055,.05,1))
    # Only the roof slopes: a solid triangular gable would fill the arch.
    for yy in (ym-rad-.55,ym+rad+.55):
        roof_plane(b,[(x0-.35,yy,3.25),(wallx-.1,yy,3.25),
                (wallx-.1,ym,4.6),(x0-.35,ym,4.6)],roof)
    ridge_cap(b,x0-.35,wallx-.1,ym,4.6,roof)
    b.box(portalx,ym,4.93,.16,.18,.85,light);b.box(portalx,ym,5.07,.16,.58,.16,light)
    # The dated ground reference shows a small pale threshold below the gate.
    # Its dimensions are a visual estimate, not a new surveyed access path.
    threshold=[(portalx-.55,ym-rad-.2),(portalx+.40,ym-rad-.2),
               (portalx+.40,ym+rad+.2),(portalx-.55,ym+rad+.2)]
    floor=[(x,y,sample(grids,anchor[0]+x,anchor[1]+y,datum)-ground+.035)for x,y in threshold]
    b.face([floor[0],floor[1],floor[2]],light)
    b.face([floor[0],floor[2],floor[3]],light)
    # North lateral open timber porch shown in the licensed frontal photograph.
    py=y1+1.35
    roof_plane(b,[(x0+3.9,y1,4.25),(x1-.8,y1,4.25),(x1-.8,py+1.15,2.75),(x0+3.9,py+1.15,2.75)],roof)
    timber=(.33,.25,.16,1)
    post_y=py+.9
    post_top=4.25+(2.75-4.25)*(post_y-y1)/(py+1.15-y1)-.06
    for xx in (x0+4.5,(x0+x1)/2,x1-1):
        base=sample(grids,anchor[0]+xx,anchor[1]+post_y,datum)-ground
        b.box(xx,post_y,(base+post_top)/2,.24,.24,post_top-base,timber)
        b.box(xx,post_y,base+.12,.48,.48,.32,light)
    # Front beam follows the actual sampled support line under the shed roof.
    b.box((x0+3.9+x1-.8)/2,post_y,post_top-.06,x1-.8-(x0+3.9),.20,.20,timber)
    # Corner quoins and restrained individual masonry variation; artistic surface.
    for xx in (x0+4.0,x1):
      for yy in (y0,y1):
       for k in range(9):b.box(xx,yy,k*.55+.28,.45 if k%2 else .7,.45,.49,light if k%3 else stone)
    for k in range(6):
      for j in range(12):
       xx=x0+4.4+j*1.2+(k%2)*.3
       if xx<x1-.35:b.box(xx,y0-.015,k*.76+.38,1.02,.035,.57,stone if (j+k)%3 else light)
    # Shallow western stone coursing gives large blank masonry readable scale.
    for k in range(9):
        z=.55+k*.73
        b.face([(wallx-.34,y0,z),(wallx-.34,y1,z),
                (wallx-.34,y1,z+.025),(wallx-.34,y0,z+.025)],(.34,.29,.22,1))
    obj=b.create_object('oca:ermita',col)
    # Separate material primitives let the runtime texture only stone masonry.
    obj.data.materials.clear()
    for name,roughness in (('oca-stone',.92),('oca-roof',.86),('oca-metal',.65)):
        mat=bpy.data.materials.new(name);mat.use_nodes=True
        principled=next((node for node in mat.node_tree.nodes if node.type=='BSDF_PRINCIPLED'),None)
        if principled is None: raise RuntimeError(f'{name}: missing Principled BSDF node')
        principled.inputs['Roughness'].default_value=roughness
        obj.data.materials.append(mat)
    for polygon,color in zip(obj.data.polygons,b.colors):
        polygon.material_index=2 if max(color[:3])<.2 or color==timber else 1 if color[0]>color[1]*1.7 else 0
    assets={}
    def export(key,obj,a):
      p=OUT/(key+'.glb');H['export_asset'](obj,p);assets[key]={'glb':f'public/village/oca-site/{key}.glb','anchor':{'x':round(a[0],6),'z':round(a[1],6)},'baseM':round(sample(grids,*a,datum)+datum,6),'yawRad':0,'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'triangles':sum(len(f.vertices)-2 for f in obj.data.polygons),'meshCount':1,'materialPrimitiveCount':len(obj.data.materials)}
    export('ermita',obj,anchor)
    # Conservative interior of the observed north meadow, not entire parcel.
    meadow=[project(*p)for p in src['campa']['traceWgs84']];ma=H['polygon_centroid'](meadow);mg=sample(grids,*ma,datum);mb=Batch();step=5
    def clip_halfplane(poly,a,c):
        def side(p):return (c[0]-a[0])*(p[1]-a[1])-(c[1]-a[1])*(p[0]-a[0])
        result=[]
        for previous,current in zip(poly[-1:]+poly[:-1],poly):
            sp,sc=side(previous),side(current)
            if (sp>=-1e-9)!=(sc>=-1e-9):
                t=sp/(sp-sc)
                result.append((previous[0]+t*(current[0]-previous[0]),previous[1]+t*(current[1]-previous[1])))
            if sc>=-1e-9:result.append(current)
        return result
    def edge_opacity(x,z):
        distance=float('inf')
        for a,c in zip(meadow,meadow[1:]+meadow[:1]):
            dx,dz=c[0]-a[0],c[1]-a[1]
            t=max(0,min(1,((x-a[0])*dx+(z-a[1])*dz)/(dx*dx+dz*dz)))
            distance=min(distance,math.hypot(x-a[0]-t*dx,z-a[1]-t*dz))
        return max(0,min(1,distance/2.5))
    def meadow_noise(x,z,spacing,seed):
        gx,gz=x/spacing,z/spacing;ix,iz=math.floor(gx),math.floor(gz)
        tx,tz=gx-ix,gz-iz
        tx,tz=tx*tx*(3-2*tx),tz*tz*(3-2*tz)
        def lattice(a,c):
            value=math.sin(a*127.1+c*311.7+seed*74.7)*43758.5453123
            return (value-math.floor(value))-.5
        low=lattice(ix,iz)*(1-tx)+lattice(ix+1,iz)*tx
        high=lattice(ix,iz+1)*(1-tx)+lattice(ix+1,iz+1)*tx
        return low*(1-tz)+high*tz
    xx=math.floor(min(x for x,z in meadow)/step)*step
    while xx<max(x for x,z in meadow):
      zz=math.floor(min(z for x,z in meadow)/step)*step
      while zz<max(z for x,z in meadow):
       sw,se,ne,nw=(xx,zz),(xx+step,zz),(xx+step,zz+step),(xx,zz+step)
       # Split on the runtime DEM SW-to-NE diagonal BEFORE sampling heights.
       # Each clipped polygon now lies in one affine terrain plane.
       for terrain_triangle in ((sw,se,ne),(sw,ne,nw)):
        clip=list(meadow)
        for edge in range(3):
            clip=clip_halfplane(clip,terrain_triangle[edge],terrain_triangle[(edge+1)%3])
            if len(clip)<3:break
        if len(clip)>=3 and H['polygon_area'](clip)>.001:
         # The sourced conservative meadow is convex; half-plane clipping
         # preserves convexity, so an explicit fan cannot cross a DEM diagonal.
         for index in range(1,len(clip)-1):
          facet=(clip[0],clip[index],clip[index+1])
          mb.face([(x-ma[0],z-ma[1],sample(grids,x,z,datum)-mg+.04)for x,z in facet],(.115,.165,.06,1))
       zz+=step
      xx+=step
    campa_obj=mb.create_object('oca:campa',col)
    # Fade only inside the sourced outline; the underlying terrain remains visible.
    colors=campa_obj.data.color_attributes['Color']
    for polygon in campa_obj.data.polygons:
        for loop_index in polygon.loop_indices:
            vertex=campa_obj.data.vertices[campa_obj.data.loops[loop_index].vertex_index]
            color=colors.data[loop_index].color[:]
            world_x,world_z=vertex.co.x+ma[0],vertex.co.y+ma[1]
            variation=meadow_noise(world_x,world_z,14,17)*.12+meadow_noise(world_x,world_z,37,29)*.08
            tint=max(.91,min(1.06,.98+variation))
            colors.data[loop_index].color=(*(channel*tint for channel in color[:3]),edge_opacity(world_x,world_z))
    export('campa',campa_obj,ma)
    (OUT/'manifest.json').write_text(json.dumps({'version':1,'crs':'EPSG:25830','verticalDatum':datum,'source':str(SOURCE.relative_to(ROOT)),'reconstruction':'Mapped OSM footprint; elevations and colors stylized from 2017 ground photographs. Campa conservative PNOA trace; no perimeter walls inferred.','assets':assets},indent=2)+'\n');print(json.dumps(assets,indent=2))
if __name__ == '__main__':
    import sys, tempfile
    if '--check' not in sys.argv:
        build()
    else:
        published = OUT
        with tempfile.TemporaryDirectory(prefix='oca-check-') as temp:
            OUT = Path(temp)
            build()
            # Export paths in the manifest are always the published paths.
            for filename in ('ermita.glb', 'campa.glb'):
                if (OUT/filename).read_bytes() != (published/filename).read_bytes():
                    raise SystemExit(f'Oca asset is not reproducible: {filename}')
            generated = load(OUT/'manifest.json')
            original = load(published/'manifest.json')
            if generated != original:
                raise SystemExit('Oca manifest is not reproducible')
            print('Oca: GLBs and manifest reproducible; published files unchanged')
