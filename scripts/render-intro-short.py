"""Edit the new single-leaf recording into a 15-second introduction with original music.

Record the current UI into artifacts/video/motion-v3/recording.json first.
Never falls back to motion-v2 footage. The original AAC score is stream-copied,
not regenerated or replaced. Authoring dependencies: PYTHONPATH=/private/tmp/teamlink-video-deps.
"""
from pathlib import Path
from bisect import bisect_left, bisect_right
from functools import lru_cache
import json, math, subprocess, hashlib
from PIL import Image, ImageDraw, ImageFont, ImageOps
import imageio_ffmpeg

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / 'artifacts/video/motion-v3'
QA = ROOT / 'artifacts/video/motion-v3-edit'
MUSIC = ROOT / 'media/teamlink-original-score.m4a'
DATA, TIMES, MARKS, FIRST_FRAME_INDEX = None, [], {}, 0
W, H, FPS, SECONDS = 1280, 720, 24, 15
MIN_SOURCE_TIME = .35
CN = '/System/Library/Fonts/STHeiti Medium.ttc'
EN = '/System/Library/Fonts/Helvetica.ttc'

def load_recording():
    global DATA, TIMES, MARKS, FIRST_FRAME_INDEX
    path = RAW / 'recording.json'
    if not path.is_file():
        raise SystemExit('New motion-v3 recording is required; old motion-v2 footage will not be reused.')
    data = json.loads(path.read_text())
    frames, marks = data.get('frames'), data.get('marks')
    if not isinstance(frames, list) or not frames or not isinstance(marks, list):
        raise SystemExit('Recording requires actual captured frames and action marks.')
    duration = data.get('duration')
    if not isinstance(duration, (int, float)) or isinstance(duration, bool) or not math.isfinite(duration) or duration <= 0:
        raise SystemExit('Recording duration is invalid.')
    times = []
    for entry in frames:
        at, name = entry.get('t'), entry.get('file')
        if not isinstance(at, (int, float)) or isinstance(at, bool) or not math.isfinite(at) or at < 0 or at > duration:
            raise SystemExit('Captured frame times must be finite and within the recording.')
        source = (RAW / name).resolve() if isinstance(name, str) else None
        if not source or not source.is_relative_to(RAW.resolve()) or not source.is_file():
            raise SystemExit('A captured frame is missing or outside the motion-v3 recording.')
        times.append(at)
    # CDP events may finish writing a few milliseconds out of arrival order.
    # Preserve the actual capture chronology, never interpolate or invent frames.
    reordered = sum(one > two for one, two in zip(times, times[1:]))
    data = {**data, 'frames':sorted(frames, key=lambda entry:entry['t']), 'reorderedArrivalPairs':reordered}
    times = sorted(times)
    required = ['draw-start', 'draw-done', 'boat-start', 'paste-done']
    action_marks = {}
    for mark in marks:
        if mark.get('name') in required:
            if mark['name'] in action_marks:
                raise SystemExit('Action marks must be unique.')
            action_marks[mark['name']] = mark.get('t')
    previous = 0
    for name in required:
        at = action_marks.get(name)
        if not isinstance(at, (int, float)) or isinstance(at, bool) or not math.isfinite(at) or not previous <= at <= duration:
            raise SystemExit('Recording requires ordered draw-start/draw-done/boat-start/paste-done marks.')
        previous = at
    first = bisect_left(times, MIN_SOURCE_TIME)
    if first >= len(times): raise SystemExit('Recording has no frame after the fullscreen startup guard.')
    DATA, TIMES, MARKS, FIRST_FRAME_INDEX = data, times, action_marks, first
    recorded.cache_clear()

@lru_cache(maxsize=24)
def font(size, english=False):
    return ImageFont.truetype(EN if english else CN, size)

@lru_cache(maxsize=16)
def recorded(index):
    return Image.open(RAW / DATA['frames'][index]['file']).convert('RGB')

def source_time(t):
    # Keep the observed order; condense synchronization waits instead of inventing changes.
    spans = [(0, 5.4, max(MIN_SOURCE_TIME, MARKS['draw-start']-.1), MARKS['draw-done']),
             (5.4, 9, MARKS['draw-done'], MARKS['boat-start']),
             (9, 13, MARKS['boat-start'], MARKS['paste-done']),
             (13, 15, MARKS['paste-done'], max(MARKS['paste-done'], DATA['duration']-.05))]
    for a,b,c,d in spans:
        if a <= t <= b:
            return c + max(0,d-c) * (t-a)/(b-a)
    return TIMES[0] if t < 0 else TIMES[-1]

def frame(t):
    at = source_time(t)
    index = max(FIRST_FRAME_INDEX,min(len(TIMES)-1,bisect_right(TIMES,at)-1))
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
    load_recording()
    if not MUSIC.is_file(): raise SystemExit('Extract the original v1 AAC score to media/teamlink-original-score.m4a first.')
    QA.mkdir(parents=True, exist_ok=True)
    output = ROOT/'media/teamlink-intro-v3.mp4'
    binary = imageio_ffmpeg.get_ffmpeg_exe()
    command = [binary,'-y','-hide_banner','-loglevel','warning',
               '-f','rawvideo','-pixel_format','rgb24','-video_size',f'{W}x{H}',
               '-framerate',str(FPS),'-i','-','-i',str(MUSIC),'-t',str(SECONDS),
               '-map','0:v:0','-map','1:a:0','-c:a','copy',
               '-c:v','libx264','-preset','slow','-crf','26','-pix_fmt','yuv420p',
               '-profile:v','high','-level','4.0','-movflags','+faststart',
               '-metadata','title=TeamLink — draw a living world',
               '-metadata','comment=New motion-v3 real single-leaf footage with the original TeamLink v1 score.',str(output)]
    encoder = subprocess.Popen(command,stdin=subprocess.PIPE)
    for i in range(FPS*SECONDS):
        image=frame(i/FPS)
        if i in [0,72,168,240,336]: image.save(QA/f'qa-{i:03}.png')
        encoder.stdin.write(image.tobytes())
    encoder.stdin.close()
    if encoder.wait(): raise SystemExit('Encoding failed')
    poster = ROOT/'web/assets/teamlink-intro-poster-v3.webp'
    frame(6.5).save(poster,format='WEBP',quality=82,method=6)
    audio = subprocess.run([binary,'-hide_banner','-loglevel','error','-i',str(output),
        '-map','0:a:0','-c:a','copy','-f','adts','pipe:1'],check=True,capture_output=True).stdout
    original_audio = subprocess.run([binary,'-hide_banner','-loglevel','error','-i',str(MUSIC),
        '-map','0:a:0','-c:a','copy','-f','adts','pipe:1'],check=True,capture_output=True).stdout
    if not audio or not original_audio.startswith(audio): raise SystemExit('Video music is not the original score packet prefix.')
    source_trail = DATA.get('state',{}).get('leafTrail',[])
    source_trail_points = len(source_trail) if isinstance(source_trail,list) else source_trail
    metadata={'duration':SECONDS,'fps':FPS,'frames':FPS*SECONDS,'resolution':[W,H],
              'recording':'artifacts/video/motion-v3/recording.json',
              'sourceDuration':DATA['duration'],'sourceFrames':len(DATA['frames']),'sourceMarks':MARKS,
              'sourceFrameOrdering':{'method':'Stable sort by actual CDP capture timestamp','outOfOrderArrivalPairs':DATA['reorderedArrivalPairs']},
              'firstSourceFrameTime':TIMES[max(FIRST_FRAME_INDEX, bisect_right(TIMES,source_time(0))-1)],
              'sourceFinalState':{**{key:DATA.get('state',{}).get(key) for key in ['revision','boats']},
                                  'leafTrailPoints':source_trail_points},
              'footage':'New motion-v3 real browser recording of a single hand-drawn leaf and boat copy/paste; no v2 footage reused.',
              'editing':'Observed actions kept in order; synchronization waits condensed. Captions mark sped-up clips.',
              'audio':{'source':'media/teamlink-original-score.m4a','originalSource':'media/teamlink-intro-v1.mp4',
                       'method':'Original AAC stream copied for the first 15 seconds without re-encoding or replacing the melody.',
                       'originalPacketPrefixVerified':True,'aacPacketSha256':hashlib.sha256(audio).hexdigest()},
              'poster':{'output':'web/assets/teamlink-intro-poster-v3.webp','bytes':poster.stat().st_size},
              'output':'media/teamlink-intro-v3.mp4','bytes':output.stat().st_size,
              'sha256':hashlib.sha256(output.read_bytes()).hexdigest()}
    (ROOT/'media/teamlink-intro-v3.json').write_text(json.dumps(metadata,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(metadata,ensure_ascii=False))
