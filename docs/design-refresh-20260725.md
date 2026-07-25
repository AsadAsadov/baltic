# Dizayn yenilənməsi — 25 iyul 2026

## Dəyişikliklər

- Ana səhifədə `Plus Jakarta Sans` şrifti faktiki olaraq aktivləşdirildi.
- Başlıq və kart mətnlərinin süni `900/950` qalınlığı azaldıldı.
- Sol və sağ reklam sahələrində bir anda yalnız cari banner göstərilir.
- Reklam rotasiyası mövcud `duration` parametrindən istifadə etməyə davam edir.
- Reklamlar desktop görünüşündə headerin altında yapışqan qalır və footerə çatanda dayanır.
- `html/body` üzərində `sticky` davranışını pozan `overflow-x: hidden` aradan qaldırıldı.
- Qısa səhifələrdə reklam sahəsinin yarıda bitməməsi üçün minimum hündürlük əlavə edildi.
- Admin panel böyük ekranda sol naviqasiya və sağ iş sahəsi olan quruluşa keçirildi.
- Admin kontenti fixed headerin altından çıxarıldı.
- Admin səhifəsində ictimai sayt footer-i gizlədildi.
- Dashboard kartları, formalar, siyahılar, inputlar və düymələr vizual olaraq vahidləşdirildi.
- Mobil və tablet admin görünüşləri ayrıca uyğunlaşdırıldı.

## Təmizlənən kod

- Brauzerdə heç bir iş görməyən köhnə inline `tailwind.config` bloku silindi.
- İstifadə olunmayan `showSideAds` vəziyyəti və onun iki ölü funksiyası silindi.
- `src/tailwind.css` daxilində inline CSS ilə təkrarlanan köhnə komponent qaydaları silindi.
- Eyni scope daxilində təsirsiz qalan bir neçə təkrar CSS qaydası birləşdirildi/silindi.
- `index.html` daxilində əvvəldən çatışmayan bağlayıcı `div` əlavə edilərək HTML quruluşu düzəldildi.

## Toxunulmayan hissələr

- `uploads`
- Prisma sxemi və miqrasiyalar
- API endpoint-ləri
- Admin autentifikasiyası
- Layihə, iş, qalereya, hero və reklam CRUD funksiyaları
