from pathlib import Path
from html import escape
from random import Random
import math

OUT=Path(__file__).parent
WORLD={'seed':17,'timeOfDay':18.67,'treeDensity':0.62,'rainIntensity':0.12,'wind':0.2}
def text(a,x,y,s,size=15,color='#F8F6EC',weight=400,lh=25):
    for i,line in enumerate(s.split('\n')):a.append(f'<text x="{x}" y="{y+i*lh+size*.86}" font-family="PingFang SC,Noto Sans SC,sans-serif" font-size="{size}" font-weight="{weight}" fill="{color}">{escape(line)}</text>')
def glass(a,x,y,w,h,r=18,opacity=.88):
    a.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="#F8F8ED" fill-opacity="{opacity}" stroke="#FFFFFF" stroke-opacity=".28"/>')
def pine(a,x,y,h,color,light=None):
    w=h*.34
    a.append(f'<path d="M{x} {y-h} Q{x-w*.2} {y-h*.72} {x-w*.62} {y-h*.58} L{x-w*.28} {y-h*.59} Q{x-w*.60} {y-h*.35} {x-w} {y-h*.22} L{x-w*.48} {y-h*.25} L{x-w*1.16} {y-h*.05} Q{x} {y+h*.07} {x+w*1.16} {y-h*.05} L{x+w*.45} {y-h*.24} L{x+w} {y-h*.22} Q{x+w*.55} {y-h*.4} {x+w*.28} {y-h*.59} L{x+w*.62} {y-h*.58} Q{x+w*.17} {y-h*.75} {x} {y-h}Z" fill="{color}"/>')
    a.append(f'<path d="M{x} {y-h*.20}V{y+h*.09}" stroke="{color}" stroke-width="{max(1,h*.045)}"/>')
    if light:a.append(f'<path d="M{x} {y-h*.88}L{x-w*.38} {y-h*.57}L{x-w*.12} {y-h*.60}" stroke="{light}" stroke-opacity=".35" fill="none" stroke-width="{max(1,h*.035)}"/>')

def scene():
    a=['''<defs>
<linearGradient id="sky" x2="0" y2="1"><stop stop-color="#567D99"/><stop offset=".42" stop-color="#AFC9C7"/><stop offset=".76" stop-color="#EAD8B6"/><stop offset="1" stop-color="#F3CB96"/></linearGradient>
<linearGradient id="sea" x2="0" y2="1"><stop stop-color="#719D9E"/><stop offset=".38" stop-color="#426F80"/><stop offset="1" stop-color="#193E58"/></linearGradient>
<linearGradient id="island" x1="0" x2="1" y2="1"><stop stop-color="#7E9E84"/><stop offset=".4" stop-color="#527F72"/><stop offset="1" stop-color="#315E60"/></linearGradient>
<linearGradient id="rightIsland" x1="0" x2="1" y2="1"><stop stop-color="#8FA991"/><stop offset=".4" stop-color="#608C7C"/><stop offset="1" stop-color="#3B6B6A"/></linearGradient>
<linearGradient id="foreground" x2=".9" y2="1"><stop stop-color="#34645C"/><stop offset=".45" stop-color="#214D4B"/><stop offset="1" stop-color="#173B46"/></linearGradient>
<radialGradient id="sunhalo"><stop stop-color="#FFE7B2" stop-opacity=".5"/><stop offset="1" stop-color="#FFE7B2" stop-opacity="0"/></radialGradient>
<linearGradient id="reflection" x2="0" y2="1"><stop stop-color="#F8D798" stop-opacity=".65"/><stop offset="1" stop-color="#D6B685" stop-opacity="0"/></linearGradient>
<clipPath id="waterClip"><rect x="0" y="460" width="1440" height="540"/></clipPath>
</defs>''']
    a.append('<g id="world-sky"><rect width="1440" height="530" fill="url(#sky)"/><ellipse cx="1060" cy="301" rx="244" ry="244" fill="url(#sunhalo)"/></g>')
    # Clouds are thin paint-like layers, all vectors.
    a.append('<g id="world-clouds" fill="#EDF0DF" opacity=".18"><path d="M610 143Q716 116 840 142Q913 146 982 139Q924 163 802 157Q692 163 610 143Z"/><path d="M97 211Q215 194 309 211Q379 221 433 209Q365 239 239 229Q150 236 97 211Z"/><path d="M1146 176Q1278 157 1442 177L1440 193Q1294 181 1146 176Z"/></g>')
    a.append('<g id="world-sun"><circle cx="1060" cy="301" r="65" fill="#FFE3A6"/><circle cx="1060" cy="301" r="69" stroke="#FFEDC2" stroke-opacity=".30" fill="none"/></g>')
    # Distant mountain chains and island silhouettes.
    a.append('<g id="world-distant-islands"><path d="M0 446Q80 428 148 441Q230 408 284 436Q336 414 403 440Q471 413 527 442Q613 422 697 445Q765 415 835 440Q912 421 978 446Q1045 427 1122 445Q1220 414 1310 443Q1388 428 1440 442V540H0Z" fill="#94B4B4"/><path d="M0 470Q134 445 220 462Q313 431 408 463Q508 438 618 465Q710 435 804 460Q913 445 1015 466Q1120 443 1230 466Q1343 439 1440 462V540H0Z" fill="#83A6A6"/></g>')
    a.append('<rect id="world-water" x="0" y="460" width="1440" height="540" fill="url(#sea)"/>')
    a.append('<ellipse cx="1060" cy="620" rx="150" ry="290" fill="url(#sunhalo)" opacity=".28" clip-path="url(#waterClip)"/>')
    rng=Random(WORLD['seed'])
    a.append('<g id="world-water-ripples" clip-path="url(#waterClip)">')
    for i in range(165):
        y=rng.uniform(466,1000);x=rng.uniform(0,1440);w=rng.uniform(12,100)*(0.4+(y-460)/540)
        warm=abs(x-1060)<65+(y-460)*.22
        color='#F7D99F' if warm else '#A1C3C2'
        opacity=rng.uniform(.08,.37) if warm else rng.uniform(.04,.17)
        a.append(f'<path d="M{x:.1f} {y:.1f}q{w*.48:.1f} {-rng.uniform(0,2):.1f} {w:.1f} 0" fill="none" stroke="{color}" stroke-opacity="{opacity:.2f}" stroke-width="{rng.uniform(.5,2):.1f}"/>')
    a.append('</g>')
    # Left middle-ground island: a broad ridge, soft green terraces and a rocky shore.
    a.append('<g id="world-left-island"><path d="M-25 500Q70 474 135 397Q198 407 258 353Q321 364 375 295Q405 274 431 301Q465 342 492 332Q552 379 579 420Q610 426 652 480Q691 487 754 555Q726 587 643 597Q485 616 348 606Q202 629 81 596Q24 575-25 574Z" fill="url(#island)"/><path d="M78 473Q136 432 177 432Q223 405 268 405Q315 369 356 369Q397 320 427 307Q398 362 385 414Q339 449 289 472Q216 486 163 519Z" fill="#A5B495" opacity=".39"/><path d="M441 321Q446 388 483 441Q533 470 565 515Q579 544 595 583Q539 574 503 541Q474 495 454 463Q426 415 441 321Z" fill="#315F60" opacity=".38"/><path d="M21 546Q151 515 269 549Q377 543 468 574Q608 560 751 555Q718 584 643 589Q520 601 382 593Q255 612 137 588Q62 585 21 567Z" fill="#C0C5A2" opacity=".48"/><path d="M-20 569Q132 604 250 605Q394 594 477 608Q610 615 751 562Q722 596 647 612Q506 641 382 626Q192 644 74 612Q15 600-20 594Z" fill="#355D62"/><path d="M82 613Q204 644 372 631Q569 651 735 594" fill="none" stroke="#A0BEB1" stroke-opacity=".48" stroke-width="3"/></g>')
    # Right island overlaps the warm water and frames the bay.
    a.append('<g id="world-right-island"><path d="M1132 500Q1192 465 1238 413Q1266 405 1292 369Q1335 381 1370 419Q1414 431 1475 421V700Q1406 693 1363 664Q1290 650 1245 608Q1191 587 1132 564Z" fill="url(#rightIsland)"/><path d="M1292 376Q1272 437 1292 481Q1339 516 1351 579Q1377 625 1440 648L1440 436Q1400 446 1364 423Q1334 391 1292 376Z" fill="#366864" opacity=".45"/><path d="M1140 559Q1206 584 1254 615Q1315 651 1371 658Q1425 689 1471 688" fill="none" stroke="#BAC7AC" stroke-width="5" opacity=".75"/><path d="M1259 607Q1270 628 1282 646Q1300 671 1322 681" fill="none" stroke="#DBE4D2" stroke-opacity=".55" stroke-width="3"/></g>')
    a.append('<g id="world-trees-mid">')
    for i in range(round(68*WORLD['treeDensity'])):
        x=rng.uniform(40,665);y=496+(x/665)*66+rng.uniform(-28,21)
        pine(a,x,y,rng.uniform(12,31),'#345F51','#D4CC9F')
    for i in range(round(43*WORLD['treeDensity'])):
        x=rng.uniform(1206,1450);y=528+(x-1206)*.28+rng.uniform(-18,18)
        pine(a,x,y,rng.uniform(15,37),'#315F54','#D7D5A8')
    a.append('</g>')
    # Quiet foreground gives the world scale, instead of a UI illustration card.
    a.append('<g id="world-foreground"><path d="M-30 739Q82 701 148 687Q213 661 283 691Q337 703 376 751Q374 817 449 882Q459 954 484 1020H-30Z" fill="url(#foreground)"/><path d="M-30 737Q74 698 141 692Q213 668 280 699Q328 715 374 754Q320 742 263 738Q203 720 150 738Q56 749-30 780Z" fill="#4A7660"/><path d="M374 759Q341 813 364 865Q388 920 405 1006" fill="none" stroke="#688471" stroke-opacity=".18" stroke-width="16"/><path d="M-10 804Q102 772 158 795Q239 802 295 841Q354 878 376 957" fill="none" stroke="#8DA184" stroke-opacity=".11" stroke-width="4"/></g>')
    a.append('<g id="world-trees-front">')
    for x,y,h in [(35,744,157),(106,713,127),(203,723,166),(281,741,116),(326,776,86),(-4,817,186)]:pine(a,x,y,h,'#224B45','#B9BF94')
    a.append('</g>')
    # One small sailboat provides human scale, never a fake person or presence badge.
    a.append('<g id="world-boat" transform="translate(852 680)"><ellipse cx="0" cy="19" rx="35" ry="4" fill="#C3D1C2" opacity=".17"/><path d="M-22 9H25L14 20H-11Z" fill="#34535A"/><path d="M0-44V9" stroke="#D5D0B3" stroke-width="2"/><path d="M-3-39L-3 5L-25 5Z" fill="#F0DDAC"/><path d="M2-30L2 5L20 5Z" fill="#C9D1B9"/></g>')
    # Light sunshower: the command “let the rain stop” has an actual visible target.
    a.append('<g id="world-rain" stroke="#D2E2DE" stroke-opacity=".12" stroke-width="1">')
    for _ in range(round(220*WORLD['rainIntensity'])):
        x=rng.uniform(10,1440);y=rng.uniform(100,890)
        a.append(f'<path d="M{x:.1f} {y:.1f}l-3 12"/>')
    a.append('</g>')
    a.append('<g id="world-birds" stroke="#547878" fill="none" stroke-linecap="round" opacity=".6"><path d="M750 308q7-6 14 0q6-5 12-1"/><path d="M786 294q5-4 10 0q5-4 9-1"/><path d="M741 327q4-3 8 0q4-3 8 0"/></g>')
    return ''.join(a)

world=scene()
desktop=['<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="1000" viewBox="0 0 1440 1000">',world]
text(desktop,40,35,'TeamLink',20,'#F9F7EC',650);text(desktop,155,41,'海岛 01',12,'#ECF0E0',450)
glass(desktop,1260,26,140,40,20,.15);text(desktop,1280,39,'手机控制  ↗',13,'#F9F7EC',500)
# A selected object's trajectory is visible only when being manipulated.
desktop.append('<g id="edit-sun-affordance"><path d="M450 172Q746 54 1060 301Q1126 354 1188 414" fill="none" stroke="#EDF2E8" stroke-opacity=".32" stroke-width="1.3" stroke-dasharray="3 8"/><circle cx="1060" cy="301" r="77" fill="none" stroke="#F8EDCB" stroke-opacity=".55" stroke-width="1"/></g>')
text(desktop,991,394,'拖动太阳 · 18:40',13,'#3B646C',450)
glass(desktop,487,842,133,32,16,.17);text(desktop,504,851,'把夕阳变成夜晚',12,'#F5F6E9',450)
glass(desktop,632,842,99,32,16,.17);text(desktop,649,851,'多一些树',12,'#F5F6E9',450)
glass(desktop,744,842,99,32,16,.17);text(desktop,761,851,'让雨停',12,'#F5F6E9',450)
glass(desktop,393,889,654,66,33,.92);text(desktop,420,913,'对这片风景说一句话…',16,'#68827E')
desktop.append('<circle cx="1008" cy="922" r="23" fill="#176D67"/>');text(desktop,1001,912,'↑',21,'#FFFFFF',500)
text(desktop,40,916,'树木 +20%',12,'#F4F5E6',500);text(desktop,119,916,'撤销',12,'#DBE8DF',450)
text(desktop,1250,936,'直接拖太阳，也能改时间',11,'#D6E7E3')
desktop.append('</svg>')

# Same seed and world state; mobile camera looks toward the sunlit right bay.
mobile=['<svg xmlns="http://www.w3.org/2000/svg" width="390" height="844" viewBox="0 0 390 844"><svg x="0" y="0" width="390" height="844" viewBox="820 0 462 1000">',world,'</svg>']
text(mobile,22,29,'海岛 01',19,'#F8F7EC',600);text(mobile,22,58,'已连接同一个世界',11,'#DDEAE0')
text(mobile,323,34,'关闭',12,'#E8EEDF')
glass(mobile,156,588,211,41,20,.25);text(mobile,176,601,'多一些树',15,'#F8F7EB',500)
text(mobile,144,648,'树木增加 20%  ·',12,'#ECF2E2',500);text(mobile,278,648,'撤销',12,'#ECF2E2',500)
glass(mobile,18,698,150,33,16,.18);text(mobile,33,708,'把夕阳变成夜晚',12,'#F5F6E9',450)
glass(mobile,179,698,98,33,16,.18);text(mobile,195,708,'让雨停',12,'#F5F6E9',450)
glass(mobile,16,754,358,65,32,.94);text(mobile,36,779,'对这个世界说一句话…',14,'#6B827D')
mobile.append('<circle cx="340" cy="787" r="22" fill="#176D67"/>');text(mobile,333,777,'↑',20,'#FFFFFF',500)
mobile.append('</svg>')
OUT.mkdir(parents=True,exist_ok=True)
(OUT/'landscape-v1.svg').write_text(''.join(desktop),encoding='utf-8')
(OUT/'landscape-mobile-v1.svg').write_text(''.join(mobile),encoding='utf-8')
print('Created landscape-v1.svg (1440×1000) and landscape-mobile-v1.svg (390×844)')
