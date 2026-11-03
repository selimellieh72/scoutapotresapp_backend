# Video fixture

`green.mp4` is generated test data: a 16×16 green frame lasting one second,
encoded as H.264/yuv420p in an MP4 container. It contains no external/user footage.

Generated with FFmpeg using:

```sh
ffmpeg -f lavfi -i color=c=green:s=16x16:d=1:r=1 -c:v libx264 -pix_fmt yuv420p -movflags +faststart green.mp4
```

FFmpeg is only needed to regenerate the fixture. Tests use the committed file
and the application's ffprobe dependency to verify real video upload/probing.
