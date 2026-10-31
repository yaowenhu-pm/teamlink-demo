"""Edit the new, actual landscape recording into a 15-second introduction.

Record the current UI into artifacts/video/motion-v2/recording.json first.
Requires Pillow and imageio-ffmpeg only for authoring. No paid API.
"""
from pathlib import Path
from bisect import bisect_right
from functools import lru_cache
import json, math, subprocess
from PIL import Image, ImageDraw, ImageFont, ImageOps
import imageio_ffmpeg

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / 'artifacts/video/motion-v2'
QA = ROOT / 'artifacts/video/motion-v2-edit'
QA.mkdir(exist_ok=True)
DATA = json.loads((RAW / 'recording.json').read_text())
TIMES = [frame['t'] for frame in DATA['frames']]
MARKS = {mark['name']: mark['t'] for mark in DATA['marks']}
W, H, FPS, SECONDS = 1280, 720, 24, 15
CN = '/System/Library/Fonts/STHeiti Medium.ttc'
EN = '/System/Library/Fonts/Helvetica.ttc'

@lru_cache(maxsize=24)
def font(size, english=False):
    return ImageFont.truetype(EN if english else CN, size)

@lru_cache(maxsize=16)
def recorded(index):
    return Image.open(RAW / DATA['frames'][index]['file']).convert('RGB')

def source_time(t):
    # Keep the observed order; condense synchronization waits instead of inventing changes.
    spans = [(0, 5.4, max(.3,MARKS['draw-start']-.1), MARKS['draw-done'] + .6),
             (5.4, 9, MARKS['draw-done'] + .6, MARKS['boat-start']),
             (9, 13, MARKS['boat-start'], MARKS['paste-done'] + .7),
             (13, 15, MARKS['paste-done'] + .7, DATA['duration'] - .1)]
    for a,b,c,d in spans:
        if a <= t <= b:
            return c + max(0,d-c) * (t-a)/(b-a)
    return TIMES[-1]

def frame(t):
    at = source_time(t)
    index = max(0,min(len(TIMES)-1,bisect_right(TIMES,at)-1))
    image = Image.new('RGB',(W,H),'#f2f5ef')
    image.paste(ImageOps.fit(recorded(index),(W,560),method=Image.Resampling.LANCZOS),(0,0))
    d = ImageDraw.Draw(image)
    if t < 5.4:
        title, sub = '画一条线。', '落叶，沿着你的想法飞。'
    elif t < 9:
        title, sub = '每一笔，都活起来。', '风、流水、飞鸟与帆船，同在一幅风景。'
    elif t < 13:
        title, sub = '直接动手，立刻看见。', '拖动、复制、撤销，都在画面里。'
    else:
        title, sub = '让想法，一起生长。', 'teamlink.yaowenhu.cn'
    d.text((50,580),title,font=font(34),fill='#284a43',stroke_width=0)
    d.text((52,630),sub,font=font(18,t>=13),fill='#6f8177')
    d.text((52,674),'TeamLink',font=font(15,True),fill='#36594e')
    d.text((1014,676),'真实操作 · 片段加速',font=font(11),fill='#87988d')
    return image.convert('RGB')

if __name__ == '__main__':
    output = ROOT/'media/teamlink-intro-v2.mp4'
    command = [imageio_ffmpeg.get_ffmpeg_exe(),'-y','-hide_banner','-loglevel','warning',
               '-f','rawvideo','-pixel_format','rgb24','-video_size',f'{W}x{H}',
               '-framerate',str(FPS),'-i','-','-t',str(SECONDS),'-an',
               '-c:v','libx264','-preset','slow','-crf','26','-pix_fmt','yuv420p',
               '-profile:v','high','-level','4.0','-movflags','+faststart',
               '-metadata','title=TeamLink — draw a living world',str(output)]
    encoder = subprocess.Popen(command,stdin=subprocess.PIPE)
    for i in range(FPS*SECONDS):
        image=frame(i/FPS)
        if i in [0,72,168,240,336]: image.save(QA/f'qa-{i:03}.png')
        encoder.stdin.write(image.tobytes())
    encoder.stdin.close()
    if encoder.wait(): raise SystemExit('Encoding failed')
    frame(6.5).save(ROOT/'web/assets/teamlink-intro-poster-v2.webp',format='WEBP',quality=80,method=6)
    metadata={'duration':SECONDS,'fps':FPS,'frames':FPS*SECONDS,'resolution':[W,H],
              'footage':'New real browser recording of hand-drawn leaf path and boat copy/paste.',
              'editing':'Observed actions kept in order; synchronization waits condensed. Captions mark sped-up clips.',
              'audio':'Silent; designed for visible muted looping playback.',
              'output':'media/teamlink-intro-v2.mp4','bytes':output.stat().st_size}
    (ROOT/'media/teamlink-intro-v2.json').write_text(json.dumps(metadata,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(metadata,ensure_ascii=False))
