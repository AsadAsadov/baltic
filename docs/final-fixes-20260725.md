# Son düzəlişlər — 25 iyul 2026

Bu paketdə aşağıdakı problemlər aradan qaldırılıb:

- Sol və sağ reklamlar admin paneldə yazılan en və hündürlüyü dəyişmədən göstərir. Məsələn, `300 × 700` banner bütün desktop zoom səviyyələrində həmin CSS ölçü və nisbətini qoruyur.
- Ana səhifə hero-su ictimai üçsütunlu quruluşun orta sütununa keçirilib. Hero və reklamlar headerin altından başlayır, bir-birinin üzərinə çıxmır.
- Hero tam ekran deyil; mərkəzləşdirilmiş, nisbəti qorunan paneldir və media `contain` rejimində kəsilmədən göstərilir.
- Qalereyada lokal video və YouTube videosu saxlandıqdan sonra siyahı köhnə keşlə sıfırlanmır. Saxlanılan nəticə dərhal admin siyahısına əlavə olunur və sonra serverdən arxa planda yenilənir.
- Lokal videolar admin qalereyasında video elementi kimi önizlənir.
- `site_audio_tracks` cədvəli yoxdursa server onu təhlükəsiz şəkildə avtomatik yaradır. Prisma miqrasiyası da idempotentdir.
- Admin panel sessiya yoxlanmadan məlumat istəmir, eyni anda təkrar başladılmır və bölmələri ilk açılışdan sonra arxa planda hazırlayır.
- Admin menyusunun ilk açılış görünüşü localStorage-dakı görünürlük parametrlərindən qurulur; yalnız “Sayt səsləri” düyməsinin qısa müddət görünməsi aradan qaldırılıb.
- Haqqımızda səhifəsindən köhnə böyük giriş başlığı silinib; şirkət tarixçəsi, tarix göstəriciləri, missiya və üstünlüklər daha kompakt, animasiyalı quruluşa keçirilib.

## VPS-də tətbiq

Arxivi `/var/www` daxilində açdıqdan sonra:

```bash
cd /var/www/balticcaspian
npm install
npm run build:css
npx prisma generate
npx prisma migrate deploy
pm2 restart balticcaspian --update-env
pm2 save
nginx -t
systemctl reload nginx
```

Brauzerdə köhnə CSS keşini tam təmizləmək üçün saytı bir dəfə `Ctrl + F5` ilə açın.
