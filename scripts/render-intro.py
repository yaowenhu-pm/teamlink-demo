"""Edit actual CDP recordings into the 30-second TeamLink website film.

Inputs: artifacts/video/raw/*/recording.json and captured JPEG frames.
Optional authoring dependencies: pillow, numpy, imageio-ffmpeg. No API keys.
Recorded room QR codes are deliberately replaced by a labelled live-entry tile:
the website creates the real, time-limited QR when a viewer opens it.
"""
from pathlib import Path
from bisect import bisect_right
from functools import lru_cache
import json, math, os, subprocess, wave
import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / 'artifacts/video/raw'
OUT = ROOT / 'media'
QA = ROOT / 'artifacts/video'
OUT.mkdir(exist_ok=True)
QA.mkdir(exist_ok=True)
W, H, FPS, SECONDS = 1600, 900, 30, 30
INK, BLUE, MUTED = '#263b55', '#3677c5', '#8b9db1'
CN = '/System/Library/Fonts/STHeiti Medium.ttc'
EN = '/System/Library/Fonts/Helvetica.ttc'

@lru_cache(maxsize=32)
def font(size, english=False):
    return ImageFont.truetype(EN if english else CN, size)

def center(draw, text, y, size, color=INK, english=False):
    face = font(size, english)
    box = draw.textbbox((0, 0), text, font=face)
    draw.text(((W - box[2] + box[0]) / 2, y), text, font=face, fill=color)

yy, xx = np.mgrid[0:H, 0:W]
glow = np.exp(-(((xx-W*.64)/(W*.5))**2 + ((yy-H*.28)/(H*.8))**2))
paper = np.empty((H, W, 3), dtype=np.uint8)
for channel, (base, tint) in enumerate(zip((250, 251, 253), (11, 6, 0))):
    paper[:, :, channel] = np.clip(base - glow*tint, 0, 255)
PAPER = Image.fromarray(paper)
LOGO = Image.open(ROOT/'web/assets/teamlink-symbol.png').convert('RGBA')
ICON = Image.open(ROOT/'web/assets/teamlink-icon.png').convert('RGBA')
RECORDINGS = {name: json.loads((RAW/name/'recording.json').read_text())
              for name in ['direct', 'conversation', 'phone', 'synchronized']}
TIMES = {name: [frame['t'] for frame in value['frames']]
         for name, value in RECORDINGS.items()}

def ease(t):
    t = min(1, max(0, t))
    return t*t*(3-2*t)

@lru_cache(maxsize=20)
def recorded_image(name, index):
    image = Image.open(RAW/name/RECORDINGS[name]['frames'][index]['file']).convert('RGB')
    if name != 'phone':
        # Remove the browser-extension bubble at the far right, keeping the app.
        image = image.crop((0, 0, 1232, 720))
        draw = ImageDraw.Draw(image)
        draw.rounded_rectangle((935, 74, 1063, 202), 10, fill='#fbfcff', outline='#e0e7f1')
        draw.rounded_rectangle((981, 94, 1019, 130), 9, fill='#e9f1fc')
        draw.text((991, 101), '↗', font=font(17), fill=BLUE)
        draw.text((969, 144), '扫码共创', font=font(14), fill='#6285b0')
        draw.text((961, 167), '网页实时生成', font=font(11), fill='#93a6bd')
    return image

def raw_frame(name, seconds):
    index = max(0, min(len(TIMES[name])-1, bisect_right(TIMES[name], seconds)-1))
    return recorded_image(name, index)

def frame_shell(canvas, screen, rect, radius=14, phone=False):
    x, y, width, height = map(int, rect)
    screen = screen.resize((width, height), Image.Resampling.LANCZOS)
    draw = ImageDraw.Draw(canvas)
    border = 7 if phone else 1
    draw.rounded_rectangle((x-border, y-border, x+width+border, y+height+border),
                           radius+border, fill='#24374f' if phone else '#dce4ee')
    mask = Image.new('L', (width, height), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, width-1, height-1), radius, fill=255)
    canvas.paste(screen, (x, y), mask)

def film_header(canvas, step):
    icon = ICON.resize((31, 31), Image.Resampling.LANCZOS)
    canvas.paste(icon, (169, 31), icon)
    draw = ImageDraw.Draw(canvas)
    draw.text((209, 34), 'TeamLink', font=font(23, True), fill=INK)
    box = draw.textbbox((0, 0), step, font=font(12))
    draw.text((1430-box[2], 40), step, font=font(12), fill='#8c9eb5')

def caption(canvas, title, detail):
    draw = ImageDraw.Draw(canvas)
    center(draw, title, 821, 54, INK)
    center(draw, detail, 883, 14, '#99a8ba')

def base_frame(t):
    canvas = PAPER.copy()
    draw = ImageDraw.Draw(canvas)
    if t < 3:
        lift = int((1-ease(t/1.1))*16)
        logo = LOGO.resize((220, 220), Image.Resampling.LANCZOS)
        canvas.paste(logo, (690, 143+lift), logo)
        center(draw, 'TeamLink', 400+lift, 70, INK, True)
        center(draw, '让想法，一起生长。', 510+lift, 47, BLUE)
        center(draw, '30 秒，看看我们如何一起创造。', 598+lift, 18, MUTED)
        center(draw, 'REAL PRODUCT DEMO  /  2026', 790, 12, '#9eafc3', True)
    elif t < 10:
        film_header(canvas, '01  /  直接操作')
        s = .6 + (t-3)/7*13.8
        frame_shell(canvas, raw_frame('direct', s), (184, 90, 1232, 720))
        caption(canvas, '动一下，变化就在眼前。', '拖动太阳 · 编辑真实参数 · 预览后同步')
    elif t < 19:
        film_header(canvas, '02  /  对话改变风景')
        s = .25 + (t-10)/9*12.3
        frame_shell(canvas, raw_frame('conversation', s), (184, 90, 1232, 720))
        caption(canvas, '说一句，风景和配置一起变。', '真实豆包调用 · 操作与等待片段经过剪辑')
    elif t < 26:
        film_header(canvas, '03  /  同一个房间')
        s = t-19
        if s < 2:
            phone_time = 4.8*s/2
        elif s < 3.2:
            phone_time = 4.8+(8.55-4.8)*(s-2)/1.2
        else:
            phone_time = 8.55+min(1, (s-3.2))*.96
        desktop = raw_frame('conversation', 12.6) if s < 3.2 else raw_frame('synchronized', s-3.2)
        frame_shell(canvas, desktop, (83, 164, 1083, 633))
        frame_shell(canvas, raw_frame('phone', phone_time), (1231, 147, 246, 532), 27, True)
        draw.text((1265, 109), '移动端网页', font=font(13), fill='#8ea2bb')
        draw.line((1185, 402, 1205, 402), fill='#9bb8da', width=2)
        draw.line((1198, 396, 1205, 402, 1198, 408), fill='#9bb8da', width=2)
        caption(canvas, '一个想法，两端一起看见。', '手机与电脑共享真实状态 · 扫码请使用网页上的实时二维码')
    else:
        lift = int((1-ease((t-26)/.9))*14)
        logo = LOGO.resize((168, 168), Image.Resampling.LANCZOS)
        canvas.paste(logo, (716, 125+lift), logo)
        center(draw, '一起动手，想象就有了形状。', 355+lift, 49, INK)
        center(draw, '无需安装，无需登录。打开网页，亲手试一试。', 450+lift, 22, MUTED)
        draw.rounded_rectangle((605, 540+lift, 995, 605+lift), 33, fill='#28486c')
        center(draw, '现在，开始共创  ↗', 557+lift, 23, '#ffffff')
        center(draw, 'teamlink-handoff.yaowen-hu.chatgpt.site', 692, 19, '#7c97b7', True)
        center(draw, 'TeamLink  /  A shared space for imagination.', 801, 12, '#9bacc0', True)
    return canvas

def final_frame(t):
    image = base_frame(t)
    for boundary in [3, 10, 19, 26]:
        if boundary <= t < boundary+.24:
            image = Image.blend(base_frame(boundary-.01), image, ease((t-boundary)/.24))
            break
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, H-3, int(W*t/SECONDS), H), fill='#a3bfdf')
    return image

def soundtrack():
    rate = 44100
    seconds = np.arange(SECONDS*rate, dtype=np.float64)/rate
    signal = np.zeros((len(seconds), 2), dtype=np.float64)
    chords = [[146.832, 220.0, 329.628, 369.994], [130.813, 195.998, 293.665, 391.995],
              [123.471, 184.997, 277.183, 369.994], [110.0, 164.814, 246.942, 329.628]]
    for k, chord in enumerate(chords):
        local = seconds-k*7.5
        envelope = np.clip(local/1.1, 0, 1)*np.clip((8.6-local)/2.5, 0, 1)
        for n, freq in enumerate(chord):
            tone = np.sin(2*np.pi*freq*local)+.16*np.sin(2*np.pi*freq*2*local)
            tremolo = .9+.1*np.sin(2*np.pi*.13*seconds+n)
            pan = .2+.6*n/3
            signal[:, 0] += .055*tone*envelope*tremolo*math.sqrt(1-pan)
            signal[:, 1] += .055*tone*envelope*tremolo*math.sqrt(pan)
    notes = [587.33, 659.255, 739.989, 880.0, 987.767, 880.0, 739.989, 659.255]
    for k, at in enumerate(np.arange(.6, 29, 1.25)):
        local = seconds-at
        envelope = np.exp(-np.maximum(local, 0)*3.4)*np.clip(local/.012, 0, 1)
        tone = np.sin(2*np.pi*notes[k%len(notes)]*local)+.19*np.sin(2*np.pi*notes[k%len(notes)]*2*local)
        for channel in range(2):
            signal[:, channel] += .045*tone*envelope*(.8+.2*math.sin(k+channel))
    original = signal.copy()
    for delay, volume in [(.27, .15), (.48, .1), (.73, .06)]:
        offset = int(delay*rate)
        signal[offset:] += original[:-offset, ::-1]*volume
    signal *= (np.clip(seconds/.8, 0, 1)*np.clip((SECONDS-seconds)/1.3, 0, 1))[:, None]
    signal *= .45/max(.001, np.max(np.abs(signal)))
    with wave.open(str(QA/'original-score.wav'), 'wb') as output:
        output.setnchannels(2); output.setsampwidth(2); output.setframerate(rate)
        output.writeframes((signal*32767).astype('<i2').tobytes())

if __name__ == '__main__':
    soundtrack()
    binary = os.environ.get('TEAMLINK_FFMPEG')
    if not binary:
        import imageio_ffmpeg
        binary = imageio_ffmpeg.get_ffmpeg_exe()
    command = [binary, '-y', '-hide_banner', '-loglevel', 'warning', '-f', 'rawvideo',
        '-pixel_format', 'rgb24', '-video_size', f'{W}x{H}', '-framerate', str(FPS), '-i', '-',
        '-i', str(QA/'original-score.wav'), '-t', str(SECONDS), '-c:v', 'libx264', '-preset', 'slow',
        '-crf', '23', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level', '4.1',
        '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart',
        '-metadata', 'title=TeamLink — 30 seconds of shared imagination',
        str(OUT/'teamlink-intro-v1.mp4')]
    encoder = subprocess.Popen(command, stdin=subprocess.PIPE)
    for index in range(FPS*SECONDS):
        t = index/FPS
        image = final_frame(t)
        if index in [0, 150, 345, 510, 600, 715, 840]:
            image.save(QA/f'qa-{index:03}.png')
        encoder.stdin.write(image.tobytes())
        if index%150 == 0:
            print(json.dumps({'renderedSeconds':round(t, 1), 'totalSeconds':SECONDS}), flush=True)
    encoder.stdin.close()
    if encoder.wait():
        raise SystemExit('Video encoding failed')
    final_frame(5.0).save(ROOT/'web/assets/teamlink-intro-poster.png', optimize=True)
    production = {'duration':30, 'fps':30, 'frames':900, 'resolution':[W,H],
        'footage':'Actual public TeamLink browser interactions captured with CDP screencast',
        'editing':'Timing condensed; waiting excerpts are labelled. No simulated model replies or shared state.',
        'qr':'Recorded temporary QR masked with a labelled live-entry tile; website QR remains real.',
        'music':'Original synthesized instrumental, created for this film; no third-party track',
        'output':'media/teamlink-intro-v1.mp4', 'bytes':(OUT/'teamlink-intro-v1.mp4').stat().st_size}
    (OUT/'teamlink-intro-v1.json').write_text(json.dumps(production,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(production,ensure_ascii=False),flush=True)
