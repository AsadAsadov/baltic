require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const intId = (req) => Number.parseInt(req.params.id, 10);
const jsonArray = (v) => Array.isArray(v) ? v : [];

const catMap = {
  house: { az: 'Taxta Ev', ru: 'Деревянный Дом', en: 'Wooden House' },
  restaurant: { az: 'Restoran', ru: 'Ресторан', en: 'Restaurant' },
  gazebo: { az: 'Besedka', ru: 'Беседка', en: 'Gazebo' },
  bath: { az: 'Hamam & Sauna', ru: 'Бани & Сауны', en: 'Bath & Sauna' },
};

function projectOut(p) {
  return { id: p.id, cat: p.category, catName: p.categoryNameAz || catMap[p.category]?.az || p.category, catNameRu: p.categoryNameRu || catMap[p.category]?.ru || p.category, catNameEn: p.categoryNameEn || catMap[p.category]?.en || p.category, title: p.titleAz, titleAz: p.titleAz, titleRu: p.titleRu, titleEn: p.titleEn, desc: p.descriptionAz, descriptionAz: p.descriptionAz, descRu: p.descriptionRu, descEn: p.descriptionEn, area: p.area, stories: p.stories, rooms: p.rooms, buildTime: p.buildTimeAz, buildTimeAz: p.buildTimeAz, buildTimeRu: p.buildTimeRu, buildTimeEn: p.buildTimeEn, image: p.coverImage, coverImage: p.coverImage, images: jsonArray(p.images), views: p.views, archived: p.archived };
}
function projectIn(b) { const c = b.cat || b.category || 'house'; return { category: c, categoryNameAz: b.catName || b.categoryNameAz || catMap[c]?.az, categoryNameRu: b.catNameRu || b.categoryNameRu || catMap[c]?.ru, categoryNameEn: b.catNameEn || b.categoryNameEn || catMap[c]?.en, titleAz: b.titleAz || b.title || '', titleRu: b.titleRu, titleEn: b.titleEn, descriptionAz: b.descAz || b.desc || b.descriptionAz, descriptionRu: b.descRu || b.descriptionRu, descriptionEn: b.descEn || b.descriptionEn, area: String(b.area || ''), stories: Number(b.stories) || 1, rooms: Number(b.rooms) || 1, buildTimeAz: b.buildTimeAz || b.buildTime, buildTimeRu: b.buildTimeRu, buildTimeEn: b.buildTimeEn, coverImage: b.image || b.coverImage || (b.images || [])[0], images: b.images || (b.image ? [b.image] : []) }; }
function galleryOut(g) { return { id: g.id, src: g.mediaUrl, mediaUrl: g.mediaUrl, images: jsonArray(g.images), title: g.titleAz, titleAz: g.titleAz, titleRu: g.titleRu, titleEn: g.titleEn, type: g.type, archived: g.archived, sortOrder: g.sortOrder }; }
function galleryIn(b) { return { mediaUrl: b.src || b.mediaUrl || '', images: b.images || (b.src ? [b.src] : []), titleAz: b.titleAz || b.title || '', titleRu: b.titleRu, titleEn: b.titleEn, type: b.type || 'image', sortOrder: Number(b.sortOrder) || 0 }; }
function slideOut(s) { return { id: s.id, image: s.image, tag: s.tagAz, tagRu: s.tagRu, tagEn: s.tagEn, title1: s.title1Az, title1Ru: s.title1Ru, title1En: s.title1En, title2: s.title2Az, title2Ru: s.title2Ru, title2En: s.title2En, desc: s.descAz, descRu: s.descRu, descEn: s.descEn, active: s.active, sortOrder: s.sortOrder }; }
function slideIn(b) { return { image: b.image || '', tagAz: b.tagAz || b.tag, tagRu: b.tagRu, tagEn: b.tagEn, title1Az: b.title1Az || b.title1, title1Ru: b.title1Ru, title1En: b.title1En, title2Az: b.title2Az || b.title2, title2Ru: b.title2Ru, title2En: b.title2En, descAz: b.descAz || b.desc, descRu: b.descRu, descEn: b.descEn, active: b.active ?? true, sortOrder: Number(b.sortOrder) || 0 }; }
function normalizePlacement(value) { return ['left', 'right', 'both'].includes(value) ? value : 'both'; }
function bannerOut(b) { return b && { id: b.id, active: b.active, type: b.type, src: b.mediaUrl, mediaUrl: b.mediaUrl, link: b.link, title: b.title, width: b.width, height: b.height, duration: b.duration, views: b.views, clicks: b.clicks, placement: normalizePlacement(b.placement || b.position), position: normalizePlacement(b.placement || b.position), createdAt: b.createdAt }; }
function bannerIn(b) { return { active: b.active ?? true, type: b.type || 'image', mediaUrl: b.src || b.mediaUrl || '', link: b.link, title: b.title, width: Number(b.width) || 160, height: Number(b.height) || 400, duration: Number(b.duration) || 15, placement: normalizePlacement(b.placement || b.position) }; }
const msgOut = (m) => ({ id: m.id, name: m.name, phone: m.phone, email: m.email || 'N/A', message: m.message, read: m.read, date: m.createdAt.toLocaleDateString('az-AZ') });

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'baltic-caspian-api' }));

app.get('/api/projects', wrap(async (req,res)=>res.json((await prisma.project.findMany({ where: req.query.includeArchived === 'true' ? {} : { archived:false }, orderBy:{ id:'desc' }})).map(projectOut))));
app.get('/api/projects/:id', wrap(async (req,res)=>res.json(projectOut(await prisma.project.findUniqueOrThrow({ where:{ id:intId(req) }})))));
app.post('/api/projects', wrap(async (req,res)=>res.status(201).json(projectOut(await prisma.project.create({ data:projectIn(req.body) })))));
app.put('/api/projects/:id', wrap(async (req,res)=>res.json(projectOut(await prisma.project.update({ where:{ id:intId(req) }, data:projectIn(req.body) })))));
app.delete('/api/projects/:id', wrap(async (req,res)=>{ await prisma.project.delete({ where:{ id:intId(req) }}); res.json({ ok:true }); }));
app.patch('/api/projects/:id/archive', wrap(async (req,res)=>{ const p=await prisma.project.findUniqueOrThrow({ where:{ id:intId(req) }}); res.json(projectOut(await prisma.project.update({ where:{ id:p.id }, data:{ archived: req.body.archived ?? !p.archived }}))); }));
app.post('/api/projects/:id/view', wrap(async (req,res)=>res.json(projectOut(await prisma.project.update({ where:{ id:intId(req) }, data:{ views:{ increment:1 }} })))));

app.get('/api/gallery', wrap(async (req,res)=>res.json((await prisma.galleryItem.findMany({ where: req.query.includeArchived === 'true' ? {} : { archived:false }, orderBy:[{sortOrder:'asc'},{id:'desc'}] })).map(galleryOut))));
app.post('/api/gallery', wrap(async (req,res)=>res.status(201).json(galleryOut(await prisma.galleryItem.create({ data:galleryIn(req.body) })))));
app.put('/api/gallery/reorder', wrap(async (req,res)=>{ await Promise.all((req.body.items||[]).map((it,i)=>prisma.galleryItem.update({where:{id:Number(it.id)},data:{sortOrder:Number(it.sortOrder ?? i)}}))); res.json({ok:true}); }));
app.put('/api/gallery/:id', wrap(async (req,res)=>res.json(galleryOut(await prisma.galleryItem.update({ where:{id:intId(req)}, data:galleryIn(req.body)})))));
app.delete('/api/gallery/:id', wrap(async (req,res)=>{ await prisma.galleryItem.delete({where:{id:intId(req)}}); res.json({ok:true}); }));
app.patch('/api/gallery/:id/archive', wrap(async (req,res)=>{ const g=await prisma.galleryItem.findUniqueOrThrow({where:{id:intId(req)}}); res.json(galleryOut(await prisma.galleryItem.update({where:{id:g.id},data:{archived:req.body.archived ?? !g.archived}}))); }));

app.get('/api/hero-slides', wrap(async (req,res)=>res.json((await prisma.heroSlide.findMany({ where:req.query.admin==='true'?{}:{active:true}, orderBy:[{sortOrder:'asc'},{id:'asc'}] })).map(slideOut))));
app.post('/api/hero-slides', wrap(async (req,res)=>res.status(201).json(slideOut(await prisma.heroSlide.create({data:slideIn(req.body)})))));
app.put('/api/hero-slides/reorder', wrap(async (req,res)=>{ await Promise.all((req.body.items||[]).map((it,i)=>prisma.heroSlide.update({where:{id:Number(it.id)},data:{sortOrder:Number(it.sortOrder ?? i)}}))); res.json({ok:true}); }));
app.put('/api/hero-slides/:id', wrap(async (req,res)=>res.json(slideOut(await prisma.heroSlide.update({where:{id:intId(req)},data:slideIn(req.body)})))));
app.delete('/api/hero-slides/:id', wrap(async (req,res)=>{await prisma.heroSlide.delete({where:{id:intId(req)}});res.json({ok:true});}));
app.patch('/api/hero-slides/:id/toggle', wrap(async (req,res)=>{ const s=await prisma.heroSlide.findUniqueOrThrow({where:{id:intId(req)}}); res.json(slideOut(await prisma.heroSlide.update({where:{id:s.id},data:{active:req.body.active ?? !s.active}}))); }));

app.get('/api/banners', wrap(async (req,res)=>res.json((await prisma.banner.findMany({orderBy:[{active:'desc'},{id:'desc'}]})).map(bannerOut))));
app.get('/api/banners/main', wrap(async (req,res)=>res.json(bannerOut(await prisma.banner.findFirst({where:{active:true},orderBy:{id:'desc'}})))));
app.post('/api/banners', wrap(async (req,res)=>res.status(201).json(bannerOut(await prisma.banner.create({data:bannerIn(req.body)})))));
app.put('/api/banners/:id', wrap(async (req,res)=>res.json(bannerOut(await prisma.banner.update({where:{id:intId(req)},data:bannerIn(req.body)})))));
app.delete('/api/banners/:id', wrap(async (req,res)=>{await prisma.banner.delete({where:{id:intId(req)}});res.json({ok:true});}));
app.patch('/api/banners/:id/toggle', wrap(async (req,res)=>{const b=await prisma.banner.findUniqueOrThrow({where:{id:intId(req)}});res.json(bannerOut(await prisma.banner.update({where:{id:b.id},data:{active:req.body.active ?? !b.active}})));}));
app.post('/api/banners/:id/view', wrap(async (req,res)=>res.json(bannerOut(await prisma.banner.update({where:{id:intId(req)},data:{views:{increment:1}}})))));
app.post('/api/banners/:id/click', wrap(async (req,res)=>res.json(bannerOut(await prisma.banner.update({where:{id:intId(req)},data:{clicks:{increment:1}}})))));

app.get('/api/messages', wrap(async (req,res)=>res.json((await prisma.contactMessage.findMany({orderBy:{id:'desc'}})).map(msgOut))));
app.post('/api/messages', wrap(async (req,res)=>res.status(201).json(msgOut(await prisma.contactMessage.create({data:{name:req.body.name,phone:req.body.phone,email:req.body.email,message:req.body.message}})))));
app.patch('/api/messages/:id/read', wrap(async (req,res)=>res.json(msgOut(await prisma.contactMessage.update({where:{id:intId(req)},data:{read:true}})))));
app.delete('/api/messages/:id', wrap(async (req,res)=>{await prisma.contactMessage.delete({where:{id:intId(req)}});res.json({ok:true});}));

app.get('/api/stats', wrap(async (req,res)=>{ const rows=await prisma.siteStat.findMany(); res.json(Object.fromEntries(rows.map(r=>[r.key,r.value]))); }));
app.put('/api/stats/:key', wrap(async (req,res)=>res.json(await prisma.siteStat.upsert({where:{key:req.params.key},create:{key:req.params.key,value:Number(req.body.value)||0},update:{value:Number(req.body.value)||0}}))));
app.post('/api/stats/event', wrap(async (req,res)=>res.status(201).json(await prisma.statEvent.create({data:{type:req.body.type,targetId:req.body.targetId,metadata:req.body.metadata||{}}}))));
app.post('/api/uploads/sign', (req,res)=>{
  const allowed = ['projects', 'gallery', 'hero', 'banners'];
  const bucket = req.body.bucket;
  if (!allowed.includes(bucket)) return res.status(400).json({ error: 'Invalid bucket', buckets: allowed });
  const safeName = path.basename(req.body.filename || 'upload');
  const objectPath = `${Date.now()}-${safeName}`;
  const publicUrl = process.env.SUPABASE_URL ? `${process.env.SUPABASE_URL}/storage/v1/object/public/${bucket}/${objectPath}` : '';
  res.json({ bucket, path: objectPath, publicUrl, uploadUrl: null, todo: 'Signed upload not implemented yet' });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'API route not found' }));
app.use((err, req, res, next) => { console.error(err); res.status(err.code === 'P2025' ? 404 : 500).json({ error: err.message || 'Server error' }); });

app.use(express.static(__dirname));
app.get('*', (req,res)=>res.sendFile(path.join(__dirname,'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Baltic Caspian API running on ${PORT}`));
