import { Video } from '@remotion/media';
import { AbsoluteFill, Composition, Img, registerRoot, Sequence, staticFile } from 'remotion';
import { buildLabel, progressHeading, videoFormat } from './manifest.ts';
import type { VideoProps } from './manifest.ts';

function Film({ scenes, progress }: VideoProps) {
  let offset = 0;
  return <AbsoluteFill style={{ backgroundColor: '#111827', color: '#ffffff', fontFamily: 'Arial, sans-serif' }}>
    {scenes.map((scene) => {
      const from = offset;
      offset += scene.frames;
      return <Sequence key={`${from}-${scene.asset}`} from={from} durationInFrames={scene.frames}>
        <AbsoluteFill style={{ padding: 24 }}>
          <div style={{ height: 54, fontSize: 28, fontWeight: 700 }}>
            ENG-105 · {progressHeading(progress)} · Member {scene.member} · {scene.variant === 'D' ? 'D: actual PNG + Remotion' : 'C: actual screencast / frame'}
          </div>
          <div style={{ height: 56, fontSize: 18, lineHeight: 1.3, overflowWrap: 'anywhere', color: '#fcd34d' }}>
            <div>{buildLabel(scene.release.buildKind)} · Desktop {scene.release.desktopVersion} · tag {scene.release.desktopTag} · SHA {scene.release.releaseSha}</div>
            <div>Lane {scene.release.lane} · Den {scene.release.denBuildIdentity} · supplied provenance receipt, not inferred from footage</div>
          </div>
          <div style={{ height: 1444, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {scene.kind === 'png'
              ? <Img src={staticFile(scene.asset)} style={{ width: '100%', height: '100%', objectFit: 'contain', backgroundColor: '#ffffff' }} />
              : <Video src={staticFile(scene.asset)} muted style={{ width: '100%', height: '100%', objectFit: 'contain' }} />}
          </div>
          <div style={{ paddingTop: 16, fontSize: 26, lineHeight: 1.2, overflowWrap: 'anywhere' }}>{scene.caption}</div>
          <div style={{ paddingTop: 10, fontSize: 22, lineHeight: 1.2, overflowWrap: 'anywhere' }}>Observed: {scene.observed}</div>
          <div style={{ paddingTop: 12, color: '#fcd34d', fontSize: 22 }}>
            {scene.hiddenApiSetup ? 'HIDDEN API SETUP — not shown in this capture' : 'Hidden API setup: none declared'}
            {' · '}{scene.assertion.state === 'passed' ? 'Reported assertion: passed (external evidence)' : `INCOMPLETE / NOT PASSING PROOF — assertion: ${scene.assertion.state}`}
          </div>
          <div style={{ position: 'absolute', bottom: 14, left: 24, fontSize: 18, color: '#cbd5e1' }}>
            Supplementary observations, not a test verdict. Audio omitted. PNG alpha: white matte; CDP JPEG dark sidebar retained.
          </div>
        </AbsoluteFill>
      </Sequence>;
    })}
  </AbsoluteFill>;
}

const defaultProps: VideoProps = { scenes: [], progress: 'partial' };

function Root() {
  return <Composition id="ENG105" component={Film} width={videoFormat.width} height={videoFormat.height} fps={videoFormat.fps}
    durationInFrames={30} defaultProps={defaultProps}
    calculateMetadata={({ props }) => ({ durationInFrames: Math.max(1, props.scenes.reduce((sum, scene) => sum + scene.frames, 0)) })} />;
}

registerRoot(Root);
