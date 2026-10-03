"""Builds the `bean` character in Blender (tested on 5.0.1).

Run inside Blender: exec(open(r"<repo>/apps/sandbox/art/bean.py").read())
Units are world blocks: the character is 1.8 tall, feet on z = 0, facing -Y
(the glTF exporter turns that into +Z forward, Y up).
"""
import math
import bpy
from mathutils import Quaternion, Vector

HEIGHT = 1.8
# Isolated metaball surface radius / element radius at stiffness 2, threshold 0.6.
K = 0.575


def clear_collection(name):
    coll = bpy.data.collections.get(name)
    if coll is None:
        coll = bpy.data.collections.new(name)
        bpy.context.scene.collection.children.link(coll)
    for ob in list(coll.objects):
        bpy.data.objects.remove(ob)
    for store in (bpy.data.meshes, bpy.data.metaballs, bpy.data.armatures, bpy.data.curves):
        for data in [d for d in store if d.users == 0]:
            store.remove(data)
    return coll


def ellipsoid(mb, co, half, stiffness=2.0, rot=None):
    """`half` = desired isolated half-extents (x, y, z)."""
    r = max(half) / K
    e = mb.elements.new(type='ELLIPSOID')
    e.co = co
    e.radius = r
    e.size_x, e.size_y, e.size_z = (h / (K * r) for h in half)
    e.stiffness = stiffness
    if rot is not None:
        e.rotation = rot
    return e


def capsule(mb, a, b, thickness, stiffness=2.0):
    """Capsule from point a to b with isolated surface radius `thickness`."""
    a, b = Vector(a), Vector(b)
    d = b - a
    e = mb.elements.new(type='CAPSULE')
    e.co = (a + b) / 2
    e.radius = thickness / K
    e.size_x = d.length / 2
    e.rotation = Vector((1, 0, 0)).rotation_difference(d.normalized())
    e.stiffness = stiffness
    return e


def ball(mb, co, radius, stiffness=2.0):
    e = mb.elements.new(type='BALL')
    e.co = co
    e.radius = radius / K
    e.stiffness = stiffness
    return e


# --- body plan (see the reference sheet: 1 px = 0.00317 blocks) ---------------

BODY_BOTTOM = 0.20
# Silhouette traced from the sheet's pixels (320.6 px per block):
# (height, half-width from the back view, front y and back y from the profile).
# Arms hide the sides between 1.15 and 0.9; those half-widths are interpolated.
BODY_PROFILE = [
    (1.75, 0.207, -0.286, 0.108),
    (1.70, 0.276, -0.348, 0.176),
    (1.65, 0.324, -0.386, 0.226),
    (1.60, 0.363, -0.411, 0.270),
    (1.55, 0.392, -0.429, 0.304),
    (1.50, 0.416, -0.441, 0.338),
    (1.45, 0.438, -0.446, 0.367),
    (1.40, 0.457, -0.444, 0.391),
    (1.35, 0.471, -0.440, 0.416),
    (1.30, 0.483, -0.432, 0.435),
    (1.25, 0.494, -0.416, 0.454),
    (1.20, 0.502, -0.392, 0.469),
    (1.15, 0.509, -0.360, 0.485),
    (1.10, 0.515, -0.325, 0.494),
    (1.05, 0.520, -0.305, 0.504),
    (1.00, 0.525, -0.305, 0.513),
    (0.95, 0.530, -0.330, 0.519),
    (0.90, 0.535, -0.382, 0.523),
    (0.85, 0.538, -0.426, 0.523),
    (0.80, 0.547, -0.457, 0.519),
    (0.75, 0.552, -0.485, 0.513),
    (0.70, 0.555, -0.504, 0.504),
    (0.65, 0.555, -0.516, 0.493),
    (0.60, 0.551, -0.522, 0.477),
    (0.55, 0.541, -0.519, 0.455),
    (0.50, 0.526, -0.513, 0.426),
    (0.45, 0.504, -0.501, 0.392),
    (0.40, 0.473, -0.479, 0.350),
    (0.35, 0.434, -0.444, 0.297),
    (0.30, 0.390, -0.392, 0.225),
]
# The chest dip runs between these two (height, front y) points of BODY_PROFILE.
DIP_SPAN = ((0.75, -0.485), (1.40, -0.444))
# The full traced dip shades as a band across the front view, which the sheet's front view
# does not show; 0.6 keeps the bean read in profile without the band.
DIP_AMOUNT = 0.6   # 0 = no dip, 1 = the traced profile on the centre line
DIP_FALLOFF = 1.0  # weight = |sin(angle)| ** falloff: 0 keeps the dip across the whole front


def spline(xs, ys):
    """Catmull-Rom through (xs, ys) (xs ascending), held flat past the ends."""
    def f(x):
        if x <= xs[0]:
            return ys[0]
        if x >= xs[-1]:
            return ys[-1]
        i = max(k for k in range(len(xs) - 1) if xs[k] <= x)
        x0, x1 = xs[i], xs[i + 1]
        t = (x - x0) / (x1 - x0)
        def slope(k):
            a, b = max(k - 1, 0), min(k + 1, len(xs) - 1)
            return (ys[b] - ys[a]) / (xs[b] - xs[a]) * (x1 - x0)
        m0, m1 = slope(i), slope(i + 1)
        t2, t3 = t * t, t * t * t
        return ((2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * m0
                + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * m1)
    return f


def body_mesh(rings=96, segments=96):
    """Bean body as a deformed UV sphere.

    A unit-sphere point (sqrt(1-u^2) cos p, sqrt(1-u^2) sin p, u) maps to height h(u) and is
    scaled by per-height factors interpolated through BODY_PROFILE.
    """
    span = HEIGHT - BODY_BOTTOM
    us, A, F, H, B = [], [], [], [], []
    # Front and back halves hang off a fixed spine (y = 0), so the chest dip stays on the front
    # instead of shifting whole rings (which shades as a band across the front view).
    # H is the front without the dip (straight between the face and the belly); the dip is
    # full on the centre line and fades out toward the sides.
    (h0, f0), (h1, f1) = DIP_SPAN
    for h, hw, front, back in sorted(BODY_PROFILE):
        u = 2 * (h - BODY_BOTTOM) / span - 1
        s = math.sqrt(1 - u * u)
        hull = f0 + (f1 - f0) * (h - h0) / (h1 - h0) if h0 < h < h1 else front
        us.append(u); A.append(hw / s); F.append(-front / s); H.append(-min(front, hull) / s); B.append(back / s)
    fa, ff, fh, fb = spline(us, A), spline(us, F), spline(us, H), spline(us, B)
    verts, faces = [], []
    for i in range(1, rings):
        u = -math.cos(math.pi * i / rings)
        s = math.sqrt(1 - u * u)
        h = BODY_BOTTOM + (u + 1) / 2 * span
        for j in range(segments):
            p = 2 * math.pi * j / segments
            sp = math.sin(p)
            if sp < 0:
                w = DIP_AMOUNT * (-sp) ** DIP_FALLOFF
                depth = w * ff(u) + (1 - w) * fh(u)
            else:
                depth = fb(u)
            verts.append((fa(u) * s * math.cos(p), depth * s * sp, h))
    verts.append((0, 0, BODY_BOTTOM))
    verts.append((0, 0, HEIGHT))
    bottom, top = len(verts) - 2, len(verts) - 1
    for i in range(rings - 2):
        for j in range(segments):
            a, b = i * segments + j, i * segments + (j + 1) % segments
            faces.append((a, b, b + segments, a + segments))
    for j in range(segments):
        faces.append((bottom, (j + 1) % segments, j))
        last = (rings - 2) * segments
        faces.append((top, last + j, last + (j + 1) % segments))
    me = bpy.data.meshes.new("bean_body")
    me.from_pydata(verts, [], faces)
    me.update()
    return me


# Limb layout for the left side (+X); the right side mirrors x. Read off the sheet's close-ups.
# The arm hangs ~4 cm off the belly (sheet front view); closer and the remesh webs them together.
SHOULDER, ELBOW, WRIST = (0.42, 0.02, 1.10), (0.70, 0.0, 0.80), (0.75, -0.03, 0.68)
PALM = ((0.76, -0.06, 0.605), (0.095, 0.12, 0.085))        # centre, half-extents
FINGER_Y = (-0.135, -0.055, 0.025)                           # three fingers, front to back
FINGER = ((0.80, 0.555), (0.75, 0.50), 0.05)                # knuckle (x, z), tip (x, z), radius: short, curled in
# The thumb hangs on the inner side, its tip ~5 cm clear of the fingertips; THUMB_CLEFT carves
# the slot between them (sheet front view: a dark gap from the bottom of the fist up to ~z 0.58).
THUMB = ((0.69, -0.10, 0.645), (0.635, -0.125, 0.545), 0.04)
THUMB_CLEFT = (0.692, -0.11, (0.46, 0.585), 0.03, 0.016)    # x, y, z range, half-width, depth
HIP, ANKLE = (0.30, 0.03, 0.40), (0.30, 0.03, 0.12)
# A long dome tilted so the heel end rides higher; it dips below the floor and is flattened later.
FOOT = ((0.39, -0.09, 0.075), (0.25, 0.32, 0.12), math.radians(3))
# The instep mound under the ankle makes the foot read as a dome from the front, not a slab.
INSTEP = ((0.33, 0.01, 0.12), (0.17, 0.19, 0.12))
TOE_DX, TOE = (-0.12, 0.0, 0.12), (-0.335, 0.08, 0.085)      # toe x offsets; toe y, z, radius: round bulbs at the tip


def mirror(p, s):
    return (s * p[0], p[1], p[2])


def build_limbs(mb):
    for s in (1, -1):
        # leg column + foot: a tilted dome with three toe lobes along the front
        capsule(mb, mirror(ANKLE, s), mirror(HIP, s), 0.15)
        ellipsoid(mb, mirror(FOOT[0], s), FOOT[1], rot=Quaternion((1, 0, 0), FOOT[2]))
        ellipsoid(mb, mirror(INSTEP[0], s), INSTEP[1])
        ty, tz, tr = TOE
        for dx in TOE_DX:
            ball(mb, (s * (FOOT[0][0] + dx), ty, tz), tr)
        # arm: an even tube from inside the shoulder, soft elbow
        capsule(mb, mirror(SHOULDER, s), mirror(ELBOW, s), 0.105)
        capsule(mb, mirror(ELBOW, s), mirror(WRIST, s), 0.10)
        # fist: palm, three fingers curled in toward the body, thumb on the inner front
        ellipsoid(mb, mirror(PALM[0], s), PALM[1])
        (kx, kz), (tx, tz2), fr = FINGER
        for y in FINGER_Y:
            capsule(mb, (s * kx, y, kz), (s * tx, y - 0.01, tz2), fr)
        a, b, r = THUMB
        capsule(mb, mirror(a, s), mirror(b, s), r)


def grooves():
    """Creases carved after the remesh: (point, plane normal, half-width, depth, region a, region b, region r).

    A vertex is pushed in along its normal when it is near the plane and inside the capsule
    region (a, b, r), which keeps each crease on its fingers or toes.
    """
    out = []
    for s in (1, -1):
        (kx, kz), (tx, tz2), _ = FINGER
        for y0, y1 in zip(FINGER_Y, FINGER_Y[1:]):
            y = (y0 + y1) / 2
            out.append(((0, y, 0), (0, 1, 0), 0.022, 0.013, (s * (kx + 0.03), y, kz + 0.01), (s * (tx - 0.02), y, tz2 - 0.03), 0.06))
        cx, cy, (cz0, cz1), half, depth = THUMB_CLEFT
        out.append(((s * cx, 0, 0), (1, 0, 0), half, depth, (s * cx, cy, cz0), (s * cx, cy, cz1), 0.085))
        ty, tz, tr = TOE
        for d0, d1 in zip(TOE_DX, TOE_DX[1:]):
            x = s * (FOOT[0][0] + (d0 + d1) / 2)
            # only over the toe lobes: the front ~10 cm of the foot, not up the instep
            out.append(((x, 0, 0), (1, 0, 0), 0.026, 0.02, (x, ty - 0.10, 0.02), (x, ty + 0.01, tz + 0.03), 0.075))
    return out


def carve(skin, creases, smooth_iterations=6):
    """Push vertices in along their normals at each crease, then smooth just the carved band:
    inside a deep slot the normals on either wall disagree and leave spikes otherwise."""
    me = skin.data
    me.update()
    group = skin.vertex_groups.new(name="carved")
    for v in me.vertices:
        p = v.co
        push = 0.0
        for point, normal, half, depth, ra, rb, rr in creases:
            dp = abs((p - Vector(point)).dot(Vector(normal)))
            if dp >= half:
                continue
            dr = seg_dist(p, ra, rb)
            if dr >= rr:
                continue
            w = (1 - (dp / half) ** 2) ** 2 * smoothstep(rr, rr * 0.6, dr)
            push = max(push, depth * w)
        if push > 0:
            v.co = p - v.normal * push
            group.add([v.index], 1.0, 'REPLACE')
    me.update()
    mod = skin.modifiers.new("carved", 'SMOOTH')
    mod.factor = 0.5
    mod.iterations = smooth_iterations
    mod.vertex_group = group.name
    with bpy.context.temp_override(object=skin, active_object=skin, selected_objects=[skin]):
        bpy.ops.object.modifier_apply(modifier=mod.name)


def flatten_soles(skin, floor=0.0, blend=0.02):
    """Feet dip below the floor; squash them onto it so they stand flat. Below floor + blend,
    z maps through floor + blend * exp(t - 1): continuous with slope 1 at the top, flat at the floor."""
    for v in skin.data.vertices:
        t = (v.co.z - floor) / blend
        if t < 1:
            v.co.z = floor + blend * math.exp(t - 1)
    skin.data.update()


def build_parts():
    """Body mesh + limb metaballs, as separate objects in the `bean_build` collection."""
    coll = clear_collection("bean_build")
    body = bpy.data.objects.new("bean_body", body_mesh())
    coll.objects.link(body)
    mb = bpy.data.metaballs.new("bean_limbs")
    mb.resolution = 0.015
    mb.render_resolution = 0.015
    mb.threshold = 0.6
    build_limbs(mb)
    limbs = bpy.data.objects.new("bean_limbs", mb)
    coll.objects.link(limbs)
    return body, limbs


def fuse(body, limbs, voxel=0.012, seam_width=0.07, smooth_iterations=25):
    """Union body + limbs into one watertight skin: voxel remesh, then fillet the seams.

    Only vertices near both the body and a limb surface are smoothed (Laplacian smoothing
    shrinks, so a global pass would thin the arms and lower the head).
    """
    import bmesh
    from mathutils.bvhtree import BVHTree
    dg = bpy.context.evaluated_depsgraph_get()
    limb_me = bpy.data.meshes.new_from_object(limbs.evaluated_get(dg))
    skin_me = body.data.copy()
    skin_me.name = "bean_skin"
    bm = bmesh.new()
    bm.from_mesh(skin_me)
    bm.from_mesh(limb_me)
    bm.to_mesh(skin_me)
    bm.free()
    skin = bpy.data.objects.new("bean_skin", skin_me)
    body.users_collection[0].objects.link(skin)
    skin_me.remesh_voxel_size = voxel
    skin_me.remesh_voxel_adaptivity = 0
    with bpy.context.temp_override(object=skin, active_object=skin, selected_objects=[skin]):
        bpy.ops.object.voxel_remesh()

    def tree(me):
        b = bmesh.new()
        b.from_mesh(me)
        t = BVHTree.FromBMesh(b)
        b.free()
        return t
    body_tree, limb_tree = tree(body.data), tree(limb_me)
    bpy.data.meshes.remove(limb_me)
    group = skin.vertex_groups.new(name="seam")
    for v in skin.data.vertices:
        d = max(body_tree.find_nearest(v.co)[3], limb_tree.find_nearest(v.co)[3])
        # Only the shoulders and hips are real seams. The hanging arm runs within a few cm of the
        # belly; smoothing there glues it to the body.
        region = max(smoothstep(0.80, 0.92, v.co.z), 1 - smoothstep(0.42, 0.52, v.co.z))
        w = (1 - d / seam_width) * region
        if w > 0:
            group.add([v.index], w * w * (3 - 2 * w), 'REPLACE')
    mod = skin.modifiers.new("seams", 'SMOOTH')
    mod.factor = 0.8
    mod.iterations = smooth_iterations
    mod.vertex_group = group.name
    with bpy.context.temp_override(object=skin, active_object=skin, selected_objects=[skin]):
        bpy.ops.object.modifier_apply(modifier=mod.name)
    for p in skin.data.polygons:
        p.use_smooth = True
    body.hide_set(True); body.hide_render = True
    limbs.hide_set(True); limbs.hide_render = True
    return skin


def retopo(skin, target_faces=3000):
    """Game-budget topology: QuadriFlow quads (deform well), falling back to a collapse decimate."""
    before = len(skin.data.polygons)
    with bpy.context.temp_override(object=skin, active_object=skin, selected_objects=[skin]):
        try:
            bpy.ops.object.quadriflow_remesh(target_faces=target_faces, use_mesh_symmetry=True,
                                             use_preserve_sharp=False, use_preserve_boundary=False,
                                             smooth_normals=False, seed=7)
        except RuntimeError as err:
            print("quadriflow failed:", err)
    if len(skin.data.polygons) == before:
        mod = skin.modifiers.new("decimate", 'DECIMATE')
        mod.ratio = target_faces * 2 / max(1, sum(len(p.vertices) - 2 for p in skin.data.polygons))
        with bpy.context.temp_override(object=skin, active_object=skin, selected_objects=[skin]):
            bpy.ops.object.modifier_apply(modifier=mod.name)
    for p in skin.data.polygons:
        p.use_smooth = True
    return skin


# Face, symmetrised from the sheet (its head is tilted a little): x, z on the front surface.
EYE = (0.147, 1.443, 0.032)                    # x, z, radius
BROW = ((0.128, 1.585), (0.17, 1.578), (0.212, 1.545))  # inner -> outer, worried
MOUTH = ((-0.052, 1.343), (-0.02, 1.352), (0.02, 1.352), (0.052, 1.343))
LINE_RADIUS = 0.0055


def project_front(skin, x, z):
    """Hit point and normal on the skin's front for a ray from the front at (x, z)."""
    from mathutils.bvhtree import BVHTree
    import bmesh
    if getattr(project_front, "_skin", None) is not skin.data:
        bm = bmesh.new(); bm.from_mesh(skin.data)
        project_front._tree, project_front._skin = BVHTree.FromBMesh(bm), skin.data
        bm.free()
    loc, normal, _, _ = project_front._tree.ray_cast(Vector((x, -3, z)), Vector((0, 1, 0)))
    return loc, normal


def build_face(skin, face_mat):
    """Eyes (flattened spheres) and brow/mouth tubes that follow the skin, joined into one object."""
    coll = skin.users_collection[0]
    parts = []
    for s in (1, -1):
        loc, n = project_front(skin, s * EYE[0], EYE[1])
        me = bpy.data.meshes.new("eye")
        import bmesh
        bm = bmesh.new()
        bmesh.ops.create_uvsphere(bm, u_segments=12, v_segments=8, radius=EYE[2])
        for v in bm.verts:
            v.co.y *= 0.55  # flatten into the skin
        bm.to_mesh(me); bm.free()
        ob = bpy.data.objects.new("eye", me)
        ob.location = loc - n * EYE[2] * 0.15
        ob.rotation_euler = n.to_track_quat('-Y', 'Z').to_euler()
        coll.objects.link(ob)
        parts.append(ob)
    lines = [[(s * x, z) for x, z in BROW] for s in (1, -1)] + [list(MOUTH)]
    for pts in lines:
        cu = bpy.data.curves.new("line", 'CURVE')
        cu.dimensions = '3D'
        cu.bevel_depth = LINE_RADIUS
        cu.bevel_resolution = 1
        cu.use_fill_caps = True
        sp = cu.splines.new('POLY')
        # densify so the tube hugs the curved skin
        dense = []
        for (x0, z0), (x1, z1) in zip(pts, pts[1:]):
            for k in range(4):
                t = k / 4
                dense.append((x0 + (x1 - x0) * t, z0 + (z1 - z0) * t))
        dense.append(pts[-1])
        sp.points.add(len(dense) - 1)
        for p, (x, z) in zip(sp.points, dense):
            loc, n = project_front(skin, x, z)
            p.co = (*(loc + n * LINE_RADIUS * 0.3), 1)
        ob = bpy.data.objects.new("line", cu)
        coll.objects.link(ob)
        parts.append(ob)
    dg = bpy.context.evaluated_depsgraph_get()
    import bmesh
    bm = bmesh.new()
    for ob in parts:
        me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
        me.transform(ob.matrix_world)
        bm.from_mesh(me)
        bpy.data.meshes.remove(me)
    face_me = bpy.data.meshes.new("bean_face")
    bm.to_mesh(face_me); bm.free()
    for ob in parts:
        bpy.data.objects.remove(ob)
    for store in (bpy.data.meshes, bpy.data.curves):
        for data in [d for d in store if d.users == 0 and d.name.startswith(("eye", "line"))]:
            store.remove(data)
    for p in face_me.polygons:
        p.use_smooth = True
    face_me.materials.append(face_mat)
    face = bpy.data.objects.new("bean_face", face_me)
    coll.objects.link(face)
    return face


# --- rig ----------------------------------------------------------------------------

def bone_chain(side):
    """Bone (name, head, tail, parent) list for one side; `side` is 'L' (+X) or 'R' (-X)."""
    s = 1 if side == 'L' else -1
    sh, el, wr = mirror(SHOULDER, s), mirror(ELBOW, s), mirror(WRIST, s)
    fist = (s * FINGER[1][0], -0.06, FINGER[1][1])
    hip, ankle, toe = mirror(HIP, s), mirror(ANKLE, s), (s * FOOT[0][0], TOE[0] - 0.05, 0.07)
    return [
        (f"upper_arm.{side}", sh, el, "head"),
        (f"forearm.{side}", el, wr, f"upper_arm.{side}"),
        (f"hand.{side}", wr, fist, f"forearm.{side}"),
        (f"leg.{side}", hip, ankle, "root"),
        (f"foot.{side}", ankle, toe, f"leg.{side}"),
    ]


BONES = [
    ("root", (0, 0, 0), (0, 0.25, 0), None),
    ("body", (0, 0, 0.30), (0, 0, 1.00), "root"),
    ("head", (0, 0, 1.00), (0, 0, 1.80), "body"),
] + bone_chain('L') + bone_chain('R')
LIMBS = {
    "arm.L": ["upper_arm.L", "forearm.L", "hand.L"], "arm.R": ["upper_arm.R", "forearm.R", "hand.R"],
    "leg.L": ["leg.L", "foot.L"], "leg.R": ["leg.R", "foot.R"],
}


def build_armature(coll):
    arm = bpy.data.armatures.new("bean_rig")
    rig = bpy.data.objects.new("bean_rig", arm)
    coll.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    rig.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    for name, head, tail, parent in BONES:
        eb = arm.edit_bones.new(name)
        eb.head, eb.tail = head, tail
        eb.roll = 0
        if parent:
            eb.parent = arm.edit_bones[parent]
        eb.use_deform = name != "root"
    bpy.ops.object.mode_set(mode='OBJECT')
    return rig


def seg_dist(p, a, b):
    a, b = Vector(a), Vector(b)
    ab = b - a
    t = max(0.0, min(1.0, (p - a).dot(ab) / ab.length_squared))
    return (a + ab * t - p).length


def smoothstep(e0, e1, x):
    t = max(0.0, min(1.0, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)


def skin_weights(skin, body, limbs, seam=0.06):
    """Procedural weights: torso vs limb from the distance to the original body / limb surfaces,
    then the nearest limb chain, blended between its bones by inverse distance."""
    import bmesh
    from mathutils.bvhtree import BVHTree
    dg = bpy.context.evaluated_depsgraph_get()
    limb_me = bpy.data.meshes.new_from_object(limbs.evaluated_get(dg))

    def tree(me):
        b = bmesh.new(); b.from_mesh(me); t = BVHTree.FromBMesh(b); b.free()
        return t
    body_tree, limb_tree = tree(body.data), tree(limb_me)
    bpy.data.meshes.remove(limb_me)
    seg = {name: (head, tail) for name, head, tail, _ in BONES}
    groups = {name: skin.vertex_groups.get(name) or skin.vertex_groups.new(name=name)
              for name, *_ in BONES if name != "root"}
    for v in skin.data.vertices:
        p = v.co
        d_body = body_tree.find_nearest(p)[3]
        d_limb = limb_tree.find_nearest(p)[3]
        limbness = smoothstep(-seam, seam, d_body - d_limb)
        w = {}
        # torso: body below, head above, blended around the chest
        up = smoothstep(0.80, 1.25, p.z)
        w["body"] = (1 - limbness) * (1 - up)
        w["head"] = (1 - limbness) * up
        if limbness > 0:
            chain = min(LIMBS.values(), key=lambda bones: min(seg_dist(p, *seg[b]) for b in bones))
            inv = {b: 1 / max(seg_dist(p, *seg[b]), 1e-4) ** 6 for b in chain}
            total = sum(inv.values())
            for b, x in inv.items():
                w[b] = w.get(b, 0) + limbness * x / total
        for name, x in w.items():
            if x > 1e-3:
                groups[name].add([v.index], x, 'REPLACE')


def bind(rig, meshes):
    for ob in meshes:
        ob.parent = rig
        mod = ob.modifiers.new("rig", 'ARMATURE')
        mod.object = rig


# --- animation ----------------------------------------------------------------------

FPS = 30
X, Y, Z = (1, 0, 0), (0, 1, 0), (0, 0, 1)


def world_rot(rig, bone, axis, degrees):
    """Pose-space quaternion for a rotation about an armature-space axis, through the bone's rest frame."""
    rest = rig.data.bones[bone].matrix_local.to_quaternion()
    q = Quaternion(Vector(axis), math.radians(degrees))
    return rest.inverted() @ q @ rest


def world_loc(rig, bone, offset):
    rest = rig.data.bones[bone].matrix_local.to_quaternion()
    return rest.inverted() @ Vector(offset)


def make_action(rig, name, frames, pose_at, step=2):
    """Keys every bone on frames 0..frames; the last key equals the first, so the clip loops.

    `pose_at(t)` (t in [0, 1)) returns (rots, locs): rots maps bone -> [(axis, degrees), ...]
    about armature-space axes, locs maps bone -> armature-space offset.
    """
    rig.animation_data_create()
    old = bpy.data.actions.get(name)
    if old:
        bpy.data.actions.remove(old)
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    rig.animation_data.action = act
    for f in range(0, frames + 1, step):
        rots, locs = pose_at((f % frames) / frames)
        for pb in rig.pose.bones:
            pb.rotation_mode = 'QUATERNION'
            q = Quaternion()
            for axis, deg in rots.get(pb.name, []):
                q = world_rot(rig, pb.name, axis, deg) @ q
            pb.rotation_quaternion = q
            pb.location = world_loc(rig, pb.name, locs.get(pb.name, (0, 0, 0)))
            pb.keyframe_insert("rotation_quaternion", frame=f)
            pb.keyframe_insert("location", frame=f)
    act.frame_range = (0, frames)
    act.use_frame_range = True
    return act


def idle_pose(t):
    c, s1 = math.cos(2 * math.pi * t), math.sin(2 * math.pi * t)
    rots = {
        "body": [(Y, 1.5 * s1)],
        "head": [(X, 1.5 * c), (Y, -1.0 * s1)],
        # hanging arms breathe out and in (a hanging bone's -Z end moves -X under +Y)
        "upper_arm.L": [(Y, -2.5 * c - 1)], "upper_arm.R": [(Y, 2.5 * c + 1)],
        "forearm.L": [(X, 3 * s1)], "forearm.R": [(X, -3 * s1)],
    }
    locs = {"body": (0, 0, -0.008 * (1 + c))}
    return rots, locs


def walk_pose(t):
    a = 2 * math.pi * t
    swing = math.sin(a)                  # +1: left leg forward
    lift_l = max(0.0, math.cos(a)) ** 2  # a foot lifts while it swings forward
    lift_r = max(0.0, -math.cos(a)) ** 2
    bob = 0.025 * (1 - math.cos(2 * a)) / 2
    sway = -math.cos(a)  # lean over the planted foot: right while the left one lifts
    # Signs (front is -Y): +X tips an upright bone forward and a hanging one backward;
    # +Y leans an upright bone toward +X (the character's left).
    rots = {
        "body": [(X, 5), (Y, 4 * sway)],
        "head": [(Y, -2.5 * sway), (X, 1.5 * math.cos(2 * a))],
        "leg.L": [(X, -24 * swing)], "leg.R": [(X, 24 * swing)],
        "foot.L": [(X, -12 * lift_l)], "foot.R": [(X, -12 * lift_r)],
        "upper_arm.L": [(X, 18 * swing), (Y, -3)], "upper_arm.R": [(X, -18 * swing), (Y, 3)],
        "forearm.L": [(X, -8 + 6 * swing)], "forearm.R": [(X, -8 - 6 * swing)],
    }
    locs = {
        "body": (0, 0, bob),
        "leg.L": (0, 0, 0.07 * lift_l), "leg.R": (0, 0, 0.07 * lift_r),
    }
    return rots, locs


def animate(rig):
    bpy.context.scene.render.fps = FPS
    idle = make_action(rig, "idle", 2 * FPS, idle_pose)
    walk = make_action(rig, "walk", FPS, walk_pose)
    # Muted NLA tracks keep both clips on the rig for the exporter; idle stays active.
    for act in (idle, walk):
        track = rig.animation_data.nla_tracks.get(act.name) or rig.animation_data.nla_tracks.new()
        track.name = act.name
        for strip in list(track.strips):
            track.strips.remove(strip)
        track.strips.new(act.name, 0, act)
        track.mute = True
    rig.animation_data.action = idle
    return idle, walk


def build_all():
    """Full pipeline: shape -> skin -> game topology -> face -> rig -> weights -> clips."""
    if bpy.context.mode != 'OBJECT':
        bpy.ops.object.mode_set(mode='OBJECT')
    body, limbs = build_parts()
    skin = fuse(body, limbs)
    carve(skin, grooves())
    flatten_soles(skin)
    retopo(skin, target_faces=6000)  # 12k tris: below this the finger and toe creases turn jagged
    skin.vertex_groups.clear()
    skin.data.materials.append(material("bean_skin", SKIN_SRGB, 0.75))
    face = build_face(skin, material("bean_face", FACE_SRGB, 0.3))
    rig = build_armature(skin.users_collection[0])
    skin_weights(skin, body, limbs)
    face.vertex_groups.new(name="head").add(list(range(len(face.data.vertices))), 1.0, 'REPLACE')
    bind(rig, [skin, face])
    animate(rig)
    return rig, skin, face


def export_glb(path, rig, meshes):
    for ob in bpy.context.view_layer.objects:
        ob.select_set(False)
    for ob in [rig, *meshes]:
        ob.hide_set(False)
        ob.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.export_scene.gltf(
        filepath=path, export_format='GLB', use_selection=True, export_yup=True,
        export_apply=False, export_texcoords=False, export_animations=True,
        export_animation_mode='ACTIONS', export_anim_single_armature=True,
        export_reset_pose_bones=True, export_skins=True, export_influence_nb=4,
        export_def_bones=False, export_force_sampling=True, export_optimize_animation_size=True,
        export_cameras=False, export_lights=False, export_extras=False,
    )


SKIN_SRGB = (0.80, 0.44, 0.30)  # lit mid-tone of the sheet is ~(0.81, 0.47, 0.33)
FACE_SRGB = (0.02, 0.02, 0.025)


def srgb_to_linear(c):
    return tuple(((x + 0.055) / 1.055) ** 2.4 if x > 0.04045 else x / 12.92 for x in c)


def material(name, srgb, roughness):
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = next(n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    lin = srgb_to_linear(srgb)
    bsdf.inputs["Base Color"].default_value = (*lin, 1)
    bsdf.inputs["Roughness"].default_value = roughness
    mat.diffuse_color = (*lin, 1)
    mat.roughness = roughness
    return mat


def render_sheet(path, size=420):
    """Front / profile / back orthographic workbench renders, side by side, like the reference sheet."""
    import numpy as np
    scene = bpy.context.scene
    cam_data = bpy.data.cameras.get("sheet_cam") or bpy.data.cameras.new("sheet_cam")
    cam_data.type = 'ORTHO'
    cam_data.ortho_scale = 2.4
    cam = bpy.data.objects.get("sheet_cam") or bpy.data.objects.new("sheet_cam", cam_data)
    if cam.name not in scene.collection.objects:
        scene.collection.objects.link(cam)
    prev = (scene.camera, scene.render.engine, scene.render.resolution_x, scene.render.resolution_y,
            scene.render.filepath)
    scene.camera = cam
    try:
        scene.render.engine = 'BLENDER_WORKBENCH'
    except TypeError:
        pass
    shading = scene.display.shading
    shading.light = 'STUDIO'
    shading.color_type = 'MATERIAL'
    scene.render.resolution_x = size
    scene.render.resolution_y = size
    scene.render.resolution_percentage = 100
    centre = Vector((0, 0, HEIGHT / 2))
    tiles = []
    # front (camera on -Y), profile (camera on +X, so the character faces left), back (camera on +Y)
    for i, d in enumerate((Vector((0, -1, 0)), Vector((1, 0, 0)), Vector((0, 1, 0)))):
        cam.location = centre + d * 10
        cam.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler()
        scene.render.filepath = f"{path}.{i}.png"
        bpy.ops.render.render(write_still=True)
        img = bpy.data.images.load(scene.render.filepath, check_existing=False)
        px = np.array(img.pixels[:], dtype=np.float32).reshape(size, size, 4)
        tiles.append(px)
        bpy.data.images.remove(img)
    sheet = np.concatenate(tiles, axis=1)
    out = bpy.data.images.new("sheet", size * 3, size, alpha=True)
    out.pixels = sheet.ravel()
    out.filepath_raw = path
    out.file_format = 'PNG'
    out.save()
    bpy.data.images.remove(out)
    (scene.camera, scene.render.engine, scene.render.resolution_x, scene.render.resolution_y,
     scene.render.filepath) = prev


def studio_lighting():
    """Soft white world + a warm key from the front-left, roughly the sheet's lighting."""
    scene = bpy.context.scene
    world = scene.world or bpy.data.worlds.new("World")
    scene.world = world
    world.use_nodes = True
    bg = next(n for n in world.node_tree.nodes if n.type == 'BACKGROUND')
    bg.inputs["Color"].default_value = (1, 1, 1, 1)
    bg.inputs["Strength"].default_value = 0.45
    vt = scene.view_settings.bl_rna.properties["view_transform"].enum_items
    if "Standard" in [i.identifier for i in vt]:
        scene.view_settings.view_transform = "Standard"
    sun_data = bpy.data.lights.get("sheet_key") or bpy.data.lights.new("sheet_key", 'SUN')
    sun_data.energy = 3.0
    sun_data.angle = math.radians(20)
    sun = bpy.data.objects.get("sheet_key") or bpy.data.objects.new("sheet_key", sun_data)
    if sun.name not in scene.collection.objects:
        scene.collection.objects.link(sun)
    sun.rotation_euler = (math.radians(55), 0, math.radians(-30))
    for n in ("Light",):
        if n in bpy.data.objects:
            bpy.data.objects[n].hide_render = True


def compare_sheet(ref_path, out_path, px_per_unit=315.6, ground_px=718, centres_px=(355, 900, 1425),
                  half_w=270, top_units=1.9, bottom_units=0.06, look=False):
    """Reference sheet crops (top row) over renders at the same scale (bottom row)."""
    import numpy as np
    ref = bpy.data.images.load(ref_path, check_existing=False)
    rw, rh = ref.size
    rpx = np.array(ref.pixels[:], dtype=np.float32).reshape(rh, rw, 4)  # rows bottom-up
    bpy.data.images.remove(ref)
    w = 2 * half_w
    h = int((top_units + bottom_units) * px_per_unit)
    y0 = rh - int(ground_px + bottom_units * px_per_unit)  # bottom row index (bottom-up)
    ref_tiles = [rpx[y0:y0 + h, c - half_w:c + half_w] for c in centres_px]

    scene = bpy.context.scene
    cam_data = bpy.data.cameras.get("sheet_cam") or bpy.data.cameras.new("sheet_cam")
    cam_data.type = 'ORTHO'
    cam_data.ortho_scale = max(w, h) / px_per_unit
    cam = bpy.data.objects.get("sheet_cam") or bpy.data.objects.new("sheet_cam", cam_data)
    if cam.name not in scene.collection.objects:
        scene.collection.objects.link(cam)
    prev = (scene.camera, scene.render.engine, scene.render.resolution_x, scene.render.resolution_y,
            scene.render.filepath)
    scene.camera = cam
    if look:
        studio_lighting()
        for engine in ('BLENDER_EEVEE', 'BLENDER_EEVEE_NEXT'):
            try:
                scene.render.engine = engine
                break
            except TypeError:
                continue
    else:
        try:
            scene.render.engine = 'BLENDER_WORKBENCH'
        except TypeError:
            pass
        scene.display.shading.light = 'STUDIO'
        scene.display.shading.color_type = 'MATERIAL'
    scene.render.resolution_x, scene.render.resolution_y = w, h
    scene.render.resolution_percentage = 100
    centre = Vector((0, 0, (top_units - bottom_units) / 2))
    tiles = []
    for i, d in enumerate((Vector((0, -1, 0)), Vector((1, 0, 0)), Vector((0, 1, 0)))):
        cam.location = centre + d * 10
        cam.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler()
        scene.render.filepath = f"{out_path}.{i}.png"
        bpy.ops.render.render(write_still=True)
        img = bpy.data.images.load(scene.render.filepath, check_existing=False)
        tiles.append(np.array(img.pixels[:], dtype=np.float32).reshape(h, w, 4))
        bpy.data.images.remove(img)
    sheet = np.concatenate([np.concatenate(tiles, axis=1), np.concatenate(ref_tiles, axis=1)], axis=0)
    out = bpy.data.images.new("compare", 3 * w, 2 * h, alpha=True)
    out.pixels = sheet.ravel()
    out.filepath_raw = out_path
    out.file_format = 'PNG'
    out.save()
    bpy.data.images.remove(out)
    (scene.camera, scene.render.engine, scene.render.resolution_x, scene.render.resolution_y,
     scene.render.filepath) = prev


SHEET = dict(px_per_unit=320.6, ground_px=727, centres_px=(348, 902, 1437))
VIEW_DIRS = (Vector((0, -1, 0)), Vector((1, 0, 0)), Vector((0, 1, 0)))  # front, profile (faces left), back
# Screen-right axis of each view, in model space.
VIEW_RIGHT = (Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((-1, 0, 0)))


def compare_detail(ref_path, out_path, regions, tile=360, look=True):
    """Zoomed reference crops (top) over renders (bottom), one column per region.

    regions: [(view, u0, u1, z0, z1)], view 0/1/2 = front/profile/back, u = screen-right units
    from the view centre, z = height. Regions should be square-ish (u1-u0 ~ z1-z0).
    """
    import numpy as np
    ppu, ground, centres = SHEET["px_per_unit"], SHEET["ground_px"], SHEET["centres_px"]
    ref = bpy.data.images.load(ref_path, check_existing=False)
    rw, rh = ref.size
    rpx = np.array(ref.pixels[:], dtype=np.float32).reshape(rh, rw, 4)
    bpy.data.images.remove(ref)
    scene = bpy.context.scene
    cam_data = bpy.data.cameras.get("sheet_cam") or bpy.data.cameras.new("sheet_cam")
    cam_data.type = 'ORTHO'
    cam = bpy.data.objects.get("sheet_cam") or bpy.data.objects.new("sheet_cam", cam_data)
    if cam.name not in scene.collection.objects:
        scene.collection.objects.link(cam)
    prev = (scene.camera, scene.render.engine, scene.render.resolution_x, scene.render.resolution_y,
            scene.render.filepath)
    scene.camera = cam
    if look:
        studio_lighting()
        for engine in ('BLENDER_EEVEE', 'BLENDER_EEVEE_NEXT'):
            try:
                scene.render.engine = engine
                break
            except TypeError:
                continue
    scene.render.resolution_x = scene.render.resolution_y = tile
    scene.render.resolution_percentage = 100
    cols = []
    for i, (view, u0, u1, z0, z1) in enumerate(regions):
        span = max(u1 - u0, z1 - z0)
        uc, zc = (u0 + u1) / 2, (z0 + z1) / 2
        # reference crop, rows bottom-up in Blender pixel order
        x0 = int(centres[view] + (uc - span / 2) * ppu)
        y0 = int(rh - ground + (zc - span / 2) * ppu)
        n = int(span * ppu)
        crop = rpx[max(0, y0):y0 + n, max(0, x0):x0 + n]
        idx = (np.arange(tile) * crop.shape[0] / tile).astype(int)
        jdx = (np.arange(tile) * crop.shape[1] / tile).astype(int)
        crop = crop[idx][:, jdx]
        # render
        cam_data.ortho_scale = span
        d = VIEW_DIRS[view]
        centre = VIEW_RIGHT[view] * uc + Vector((0, 0, zc))
        cam.location = centre + d * 10
        cam.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler()
        if look:
            # key light from over the camera's left shoulder, like the sheet
            towards = -(d + Vector((0, 0, 1.1)) - VIEW_RIGHT[view] * 0.6)
            bpy.data.objects["sheet_key"].rotation_euler = towards.to_track_quat('-Z', 'Y').to_euler()
        scene.render.filepath = f"{out_path}.{i}.png"
        bpy.ops.render.render(write_still=True)
        img = bpy.data.images.load(scene.render.filepath, check_existing=False)
        render = np.array(img.pixels[:], dtype=np.float32).reshape(tile, tile, 4)
        bpy.data.images.remove(img)
        cols.append(np.concatenate([render, crop], axis=0))
    sheet = np.concatenate(cols, axis=1)
    out = bpy.data.images.new("detail", sheet.shape[1], sheet.shape[0], alpha=True)
    out.pixels = sheet.ravel()
    out.filepath_raw = out_path
    out.file_format = 'PNG'
    out.save()
    bpy.data.images.remove(out)
    (scene.camera, scene.render.engine, scene.render.resolution_x, scene.render.resolution_y,
     scene.render.filepath) = prev


def measure(ob, heights=(1.7, 1.5, 1.3, 1.05, 0.85, 0.6, 0.4, 0.25)):
    """Silhouette of the body column (|x| < 0.6) at each height: half-width, front y, back y."""
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    zs = [v.co.z for v in me.vertices]
    out = {"top": max(zs), "bottom": min(zs)}
    for h in heights:
        sl = [v.co for v in me.vertices if abs(v.co.z - h) < 0.015]
        body = [c for c in sl if abs(c.x) < 0.6]
        out[h] = (
            round(max((abs(c.x) for c in body), default=0), 3),
            round(min((c.y for c in body), default=0), 3),
            round(max((c.y for c in body), default=0), 3),
        )
    bpy.data.meshes.remove(me)
    return out
