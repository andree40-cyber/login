(() => {
      'use strict';
      const $ = (id) => document.getElementById(id);
      const pageLoader=$('pageLoader'),loaderStart=performance.now();
      function dismissPageLoader(){
        const delay=Math.max(0,600-(performance.now()-loaderStart));
        window.setTimeout(()=>{
          pageLoader.classList.add('is-hidden');
          window.setTimeout(()=>pageLoader.remove(),400);
        },delay);
      }
      if(document.readyState==='complete')dismissPageLoader();
      else window.addEventListener('load',dismissPageLoader,{once:true});
      const velocity = $('velocity'), angle = $('angle'), gravity = $('gravity');
      const targetHeight=$('targetHeight'), targetTime=$('targetTime'), fitGraphBtn=$('fitGraphBtn');
      const canvas = $('trajectoryCanvas'), ctx = canvas.getContext('2d');
      const launchBtn = $('launchBtn'), launchText = $('launchText');
      const resetBtn = $('resetBtn'), status = $('simStatus'), speed = $('playbackSpeed');
      const numberFormat = (n, digits = 2) => Number(n).toLocaleString('es-PE', {minimumFractionDigits: digits,maximumFractionDigits: digits});
      let values, progress = 0, playing = false, raf = 0, lastFrameTime = 0, flightDurationMs = 1700, rocketVisible = false;
      let previewing = false;
      let cameraMaxX = 0, cameraMaxY = 0;
      const reference = (()=>{const v=50,t=Math.PI/4,g=9.81;return {g, vx:v*Math.cos(t), vy:v*Math.sin(t), T:2*v*Math.sin(t)/g};})();
      const rocketImage = new Image();
      rocketImage.addEventListener('load',()=>render());
      rocketImage.src = document.querySelector('.hero-rocket').src;
      let cw = 600, ch = 370;


      // Sonido sintetizado con Web Audio: no se necesitan archivos ni internet.
      // Los navegadores habilitan el audio después de pulsar un botón.
      const soundToggle=$('soundToggle'), soundVolume=$('soundVolume');
      const soundIcon=$('soundIcon'), soundLabel=$('soundLabel'), audioHint=$('audioHint');
      const AudioEngine=window.AudioContext || window.webkitAudioContext;
      const controlPanel=$('simControls'), controlsIndicator=$('controlsIndicator');
      let soundEnabled=true, audioContext=null, masterSound=null, sceneBus=null;
      let windAudio=null, noiseBuffer=null;
      const panelControls=Array.from(controlPanel.querySelectorAll('input, select, button')).filter(el=>el!==launchBtn&&el!==resetBtn);
      if(!AudioEngine){
        soundToggle.disabled=true;
        soundToggle.setAttribute('aria-label','El navegador no admite audio');
        audioHint.textContent='El navegador no admite Web Audio; la simulación funciona igualmente sin sonido.';
      }
      function updateAudioUI(){
        soundToggle.setAttribute('aria-pressed',String(soundEnabled));
        soundLabel.textContent=soundEnabled?'Sonido activado':'Sonido silenciado';
        soundIcon.textContent=soundEnabled?'🔊':'🔇';
        soundVolume.disabled=!soundEnabled;
        updateSliderFill(soundVolume);
      }
      function setControlPanelLocked(locked){
        panelControls.forEach(el=>{
          if(el===soundToggle)el.disabled=locked||!AudioEngine;
          else if(el===soundVolume)el.disabled=locked||!soundEnabled;
          else el.disabled=locked;
        });
        controlPanel.classList.toggle('is-flight-locked',locked);
        controlsIndicator.textContent=locked?'BLOQUEADO':'ACTIVO';
      }
      function getAudio(){
        if(!AudioEngine)return null;
        try{
          if(!audioContext){
            audioContext=new AudioEngine();
            masterSound=audioContext.createGain();
            masterSound.gain.value=.36*Number(soundVolume.value)/100;
            masterSound.connect(audioContext.destination);
            // La misma textura de ruido sirve para combustión, viento y colisión.
            noiseBuffer=audioContext.createBuffer(1,Math.ceil(audioContext.sampleRate*2),audioContext.sampleRate);
            const a=noiseBuffer.getChannelData(0);
            for(let i=0;i<a.length;i++)a[i]=Math.random()*2-1;
          }
          if(audioContext.state==='suspended')audioContext.resume().catch(()=>{});
          return audioContext;
        }catch{
          audioHint.textContent='No fue posible iniciar el audio en este navegador.';
          return null;
        }
      }
      function addTone(bus,type,freq1,freq2,start,duration,amplitude){
        const a=audioContext, o=a.createOscillator(), g=a.createGain();
        o.type=type;
        o.frequency.setValueAtTime(Math.max(20,freq1),start);
        o.frequency.exponentialRampToValueAtTime(Math.max(20,freq2),start+duration);
        g.gain.setValueAtTime(.0001,start);
        g.gain.linearRampToValueAtTime(amplitude,start+.045);
        g.gain.exponentialRampToValueAtTime(.0001,start+duration);
        o.connect(g);g.connect(bus);
        o.start(start);o.stop(start+duration+.025);
      }
      function addNoise(bus,filterType,freq1,freq2,start,duration,peak){
        const a=audioContext,n=a.createBufferSource(),filter=a.createBiquadFilter(),g=a.createGain();
        n.buffer=noiseBuffer;
        filter.type=filterType;filter.Q.value=.7;
        filter.frequency.setValueAtTime(Math.max(30,freq1),start);
        filter.frequency.exponentialRampToValueAtTime(Math.max(30,freq2),start+duration);
        g.gain.setValueAtTime(.0001,start);
        g.gain.linearRampToValueAtTime(peak,start+Math.min(.08,duration*.17));
        g.gain.exponentialRampToValueAtTime(.0001,start+duration);
        n.connect(filter);filter.connect(g);g.connect(bus);
        n.start(start);n.stop(start+duration+.02);
      }
      function playTakeoff(bus){
        const t=audioContext.currentTime+.012;
        // Encendido profundo del motor + soplido de combustión creciente.
        addNoise(bus,'lowpass',220,1900,t,1.7,.78);
        addTone(bus,'sawtooth',65,160,t,1.35,.23);
        addTone(bus,'sine',95,48,t,.62,.36);
      }
      function startWind(bus){
        const a=audioContext,t=a.currentTime;
        const source=a.createBufferSource(),filter=a.createBiquadFilter(),gain=a.createGain();
        source.buffer=noiseBuffer;source.loop=true;
        filter.type='bandpass';filter.frequency.value=900;filter.Q.value=.54;
        gain.gain.setValueAtTime(.0001,t);
        gain.gain.linearRampToValueAtTime(.22,t+.55);
        source.connect(filter);filter.connect(gain);gain.connect(bus);
        const whine=a.createOscillator(),whineGain=a.createGain();
        whine.type='triangle';whine.frequency.value=380;
        whineGain.gain.setValueAtTime(.0001,t);
        whineGain.gain.linearRampToValueAtTime(.016,t+.55);
        whine.connect(whineGain);whineGain.connect(bus);
        source.start(t);whine.start(t);
        windAudio={source,gain,filter,whine,whineGain};
      }
      function fadeWind(){
        if(!windAudio||!audioContext)return;
        const a=audioContext,t=a.currentTime,wind=windAudio;
        for(const g of [wind.gain,wind.whineGain]){
          const val=Math.max(.0001,g.gain.value);
          g.gain.cancelScheduledValues(t);
          g.gain.setValueAtTime(val,t);
          g.gain.exponentialRampToValueAtTime(.0001,t+.16);
        }
        try{wind.source.stop(t+.19);wind.whine.stop(t+.19);}catch{}
        windAudio=null;
      }
      function endAudioScene(){
        if(!audioContext)return;
        fadeWind();
        if(sceneBus){
          const t=audioContext.currentTime,level=sceneBus.gain;
          level.cancelScheduledValues(t);
          level.setValueAtTime(Math.max(.0001,level.value),t);
          level.exponentialRampToValueAtTime(.0001,t+.13);
          sceneBus=null;
        }
      }
      function startFlightAudio(isNewLaunch){
        if(!soundEnabled)return;
        const a=getAudio();if(!a)return;
        endAudioScene();
        sceneBus=a.createGain();sceneBus.gain.value=1;sceneBus.connect(masterSound);
        if(isNewLaunch)playTakeoff(sceneBus);
        startWind(sceneBus);
        audioHint.textContent=isNewLaunch?'🚀 ¡Despegue! Sonido del motor encendido.':'💨 Sonido del viento durante el vuelo.';
      }
      function updateFlightAudio(){
        if(!windAudio||!audioContext||!soundEnabled)return;
        const t=audioContext.currentTime,rate=Number(speed.value);
        // El sonido del aire cambia suavemente según el avance y la reproducción.
        const amount=.12+.11*Math.sin(Math.PI*progress);
        windAudio.gain.gain.setTargetAtTime(amount,t,.12);
        windAudio.filter.frequency.setTargetAtTime(650+350*progress+rate*90,t,.16);
        windAudio.whine.frequency.setTargetAtTime(320+rate*75+progress*210,t,.19);
        if(progress>.2&&progress<.95)audioHint.textContent='💨 En el aire: se escucha el viento mientras el cohete avanza.';
      }
      function playImpact(){
        if(!soundEnabled||!sceneBus||!audioContext)return;
        fadeWind();
        const t=audioContext.currentTime+.012;
        // Golpe inicial, explosión grave y cascada corta de fragmentos.
        addNoise(sceneBus,'lowpass',4500,160,t,1.5,1.02);
        addNoise(sceneBus,'highpass',2600,600,t,.26,.48);
        addTone(sceneBus,'sine',125,33,t,.84,.7);
        addTone(sceneBus,'triangle',280,57,t,.48,.19);
        audioHint.textContent='💥 ¡Impacto! El proyectil ha llegado al suelo.';
      }
      soundToggle.addEventListener('click',()=>{
        soundEnabled=!soundEnabled;
        if(!soundEnabled){endAudioScene();audioHint.textContent='🔇 Efectos silenciados. La simulación sigue funcionando.';}
        else{
          audioHint.textContent='🔊 Sonido activado: despegue, vuelo e impacto.';
          if(playing)startFlightAudio(false);
        }
        updateAudioUI();
      });
      soundVolume.addEventListener('input',()=>{
        updateSliderFill(soundVolume);
        if(masterSound&&audioContext){
          masterSound.gain.setTargetAtTime(.36*Number(soundVolume.value)/100,audioContext.currentTime,.035);
        }
      });
      updateAudioUI();

      function updateSliderFill(el) {
        const min = Number(el.min), max = Number(el.max), v = Number(el.value);
        el.style.setProperty('--fill', `${((v - min) / (max - min)) * 100}%`);
      }
      function calculate() {
        const v = Number(velocity.value), theta = Number(angle.value) * Math.PI / 180, g = Number(gravity.value);
        const vx = v * Math.cos(theta), vy = v * Math.sin(theta);
        const T = 2 * vy / g, R = vx * T, H = (vy * vy) / (2 * g);
        return {v, theta, g, vx, vy, T, R, H};
      }
      function formatValues() {
        values = calculate();
        $('velocityValue').textContent = `${numberFormat(values.v,1)} m/s`;
        $('angleValue').textContent = `${angle.value}°`;
        $('gravityValue').textContent = `${numberFormat(gravity.value)} m/s²`;
        $('rangeResult').textContent = numberFormat(values.R);
        $('heightResult').textContent = numberFormat(values.H);
        $('timeResult').textContent = numberFormat(values.T);
        // Altura y tiempo no son independientes: ambos dependen de v, θ y g.
        // Cada control inverso ajusta v respetando ese mismo modelo físico.
        const sin=Math.sin(values.theta),minV=Number(velocity.min),maxV=Number(velocity.max);
        const minH=(minV*sin)**2/(2*values.g),maxH=(maxV*sin)**2/(2*values.g);
        const minT=2*minV*sin/values.g,maxT=2*maxV*sin/values.g;
        targetHeight.min=String(minH);targetHeight.max=String(maxH);
        targetTime.min=String(minT);targetTime.max=String(maxT);
        targetHeight.value=String(values.H);targetTime.value=String(values.T);
        $('targetHeightValue').textContent = `${numberFormat(values.H)} m`;
        $('targetTimeValue').textContent = `${numberFormat(values.T)} s`;
        $('heightMinLabel').textContent=`${numberFormat(minH,minH<10?2:0)} m`;
        $('heightMaxLabel').textContent=`${numberFormat(maxH,maxH<10?2:0)} m`;
        $('timeMinLabel').textContent=`${numberFormat(minT)} s`;
        $('timeMaxLabel').textContent=`${numberFormat(maxT)} s`;
        [velocity,angle,gravity,targetHeight,targetTime].forEach(updateSliderFill);
        document.querySelectorAll('[data-gravity]').forEach(btn => {
          btn.setAttribute('aria-pressed', String(Math.abs(Number(btn.dataset.gravity) - values.g) < 0.02));
        });
      }
      function reframeCamera(){
        cameraMaxX=Math.max(50,values.R*1.22);
        cameraMaxY=Math.max(15,values.H*1.37);
      }
      function keepCameraStable(){
        if(!cameraMaxX||!cameraMaxY){reframeCamera();return;}
        // Never shrink axes automatically when a slider moves: otherwise
        // every parabolic path appears unchanged after a recalculation.
        cameraMaxX=Math.max(cameraMaxX,values.R*1.12);
        cameraMaxY=Math.max(cameraMaxY,values.H*1.19);
      }
      function timeCoords(t) {return { x: values.vx * t, y: Math.max(0, values.vy * t - .5 * values.g * t*t)};}
      function setupCanvas() {
        const rect = canvas.getBoundingClientRect();
        const w = Math.max(200, rect.width), h = Math.max(190, rect.height);
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        cw=w; ch=h;
        canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);
        ctx.setTransform(dpr,0,0,dpr,0,0);
        render();
      }
      function drawRocket(x,y,rotation,phase) {
        ctx.save();ctx.translate(x,y);
        // The supplied artwork points NE (-45°); align its nose with the instantaneous velocity.
        ctx.rotate(rotation+Math.PI/4);
        if(rocketImage.complete && rocketImage.naturalWidth){
          const w=cw<450?58:80, h=w*rocketImage.naturalHeight/rocketImage.naturalWidth;
          ctx.shadowColor='#fc658b';ctx.shadowBlur=10;
          ctx.drawImage(rocketImage,-w*.52,-h*.5,w,h);
        } else {
          ctx.fillStyle='#ff637d';ctx.beginPath();ctx.arc(0,0,5,0,Math.PI*2);ctx.fill();
        }
        ctx.restore();
      }
      function render() {
        if (!ctx || !values) return;
        ctx.clearRect(0,0,cw,ch);
        const pad={left:cw < 450 ? 37:54,right:26,top:57,bottom:51};
        const gw=cw-pad.left-pad.right, gh=ch-pad.top-pad.bottom;
        const base=ch-pad.bottom;
        const mx = Math.max(1,cameraMaxX), my=Math.max(1,cameraMaxY);
        const visualProgress=(!playing && progress===0 && previewing)?0.48:progress;
        const px=(x)=>pad.left+(x/mx)*gw;
        const py=(y)=>base-(y/my)*gh;
        ctx.font='10px system-ui, sans-serif';ctx.textAlign='right';ctx.textBaseline='middle';
        for(let i=0;i<=4;i++){
          const y=pad.top+(i/4)*gh;
          ctx.strokeStyle='#7b99ce17';ctx.lineWidth=1;ctx.setLineDash([3,7]);
          ctx.beginPath();ctx.moveTo(pad.left,y);ctx.lineTo(cw-pad.right,y);ctx.stroke();
          ctx.fillStyle='#6f87ae';ctx.fillText(numberFormat(my*(1-i/4),0),pad.left-8,y);
        }
        ctx.textAlign='center';ctx.textBaseline='top';
        for(let i=0;i<=5;i++){
          const x=pad.left+(i/5)*gw;
          ctx.strokeStyle='#7b99ce13';ctx.beginPath();ctx.moveTo(x,pad.top);ctx.lineTo(x,base);ctx.stroke();
          ctx.fillStyle='#6f87ae';ctx.fillText(numberFormat(mx*i/5,0),x,base+14);
        }
        ctx.setLineDash([]);
        // Fixed baseline comparison makes changes in shape visible when parameters move.
        ctx.save();ctx.beginPath();ctx.setLineDash([2,8]);ctx.strokeStyle='#8baac65a';ctx.lineWidth=1.4;
        for(let i=0;i<=130;i++){
          const t=reference.T*i/130;
          const x=reference.vx*t,y=Math.max(0,reference.vy*t-.5*reference.g*t*t);
          if(!i)ctx.moveTo(px(x),py(y));else ctx.lineTo(px(x),py(y));
        }
        ctx.stroke();ctx.restore();
        ctx.strokeStyle='#476c97';ctx.lineWidth=1.2;ctx.beginPath();ctx.moveTo(pad.left,base);ctx.lineTo(cw-pad.right,base);ctx.stroke();
        const tPeak=values.T/2, apex=timeCoords(tPeak);
        const ax=px(apex.x), ay=py(apex.y), impactX=px(values.R);
        ctx.setLineDash([4,5]);ctx.strokeStyle='#967ddd75';ctx.beginPath();ctx.moveTo(ax,ay);ctx.lineTo(ax,base);ctx.stroke();ctx.setLineDash([]);
        ctx.fillStyle='#c09dff';ctx.beginPath();ctx.arc(ax,ay,4.5,0,Math.PI*2);ctx.fill();
        ctx.font='bold 10px system-ui, sans-serif';ctx.fillStyle='#c2afff';ctx.textAlign='center';ctx.fillText('ALTURA MÁX.',ax,Math.max(pad.top-10,ay-20));
        ctx.strokeStyle='#4376d5a0';ctx.lineWidth=2;ctx.setLineDash([4,5]);ctx.beginPath();
        const steps=190;
        for(let i=0;i<=steps;i++){const t=values.T*i/steps,p=timeCoords(t);if(!i)ctx.moveTo(px(p.x),py(p.y));else ctx.lineTo(px(p.x),py(p.y));}
        ctx.stroke();ctx.setLineDash([]);
        const gradient=ctx.createLinearGradient(pad.left,base,impactX,ay);
        gradient.addColorStop(0,'#5fbdff');gradient.addColorStop(.55,'#85deff');gradient.addColorStop(1,'#ad97ff');
        ctx.beginPath();for(let i=0;i<=Math.max(1,Math.round(steps*visualProgress));i++){
          const t=values.T*Math.min(i/steps,visualProgress),p=timeCoords(t);
          if(!i)ctx.moveTo(px(p.x),py(p.y));else ctx.lineTo(px(p.x),py(p.y));
        }
        if(visualProgress>0){const end=timeCoords(values.T*visualProgress);ctx.lineTo(px(end.x),py(end.y));}
        ctx.strokeStyle=gradient;ctx.lineWidth=3.4;ctx.shadowColor='#4bc7ff';ctx.shadowBlur=9;ctx.stroke();ctx.shadowBlur=0;
        ctx.fillStyle='#71d6ff';ctx.beginPath();ctx.arc(pad.left,base,4.5,0,Math.PI*2);ctx.fill();
        ctx.font='bold 10px system-ui, sans-serif';ctx.textAlign='left';ctx.fillStyle='#7edaff';ctx.fillText('INICIO',pad.left,base-20);
        ctx.fillStyle='#64e2b8';ctx.beginPath();ctx.arc(impactX,base,5,0,Math.PI*2);ctx.fill();
        ctx.textAlign='right';ctx.fillStyle='#79e6c3';ctx.fillText('IMPACTO',Math.min(cw-8,impactX),base-20);
        if(visualProgress<1){
          if(rocketVisible){
            const t=values.T*visualProgress,p=timeCoords(t);
            const dx=values.vx*gw/mx,dy=-(values.vy-values.g*t)*gh/my;
            drawRocket(px(p.x),py(p.y),Math.atan2(dy,dx),visualProgress);
          }
        } else {ctx.strokeStyle='#76ecc3';ctx.lineWidth=2;ctx.beginPath();ctx.arc(impactX,base,10,0,Math.PI*2);ctx.stroke();}
        const now = timeCoords(values.T*visualProgress);
        $('liveTime').textContent=`${numberFormat(values.T*visualProgress)} s`;
        $('liveHeight').textContent=`${numberFormat(now.y)} m`;
        $('liveTimeLabel').textContent=previewing&&!playing&&progress===0?'Tiempo estimado':'Tiempo transcurrido';
        $('liveHeightLabel').textContent=previewing&&!playing&&progress===0?'Altura prevista':'Altura actual';
      }
      function updateButton() {
        if(playing){
          launchText.textContent='Pausar simulación';
          status.textContent='EN VUELO';
        }else if(progress>=1){
          launchText.textContent='Lanzar proyectil';
          status.textContent='VUELO COMPLETADO';
        }else if(progress>0){
          launchText.textContent='Continuar simulación';
          status.textContent='EN PAUSA';
        }else if(previewing){
          launchText.textContent='Lanzar proyectil';
          status.textContent='AJUSTANDO EN VIVO';
        }else{
          launchText.textContent='Lanzar proyectil';
          status.textContent='LISTO PARA LANZAR';
        }
        setControlPanelLocked(playing);
        status.style.color=playing?'#79dbff':'#78e1cb';
      }
      function stopFrame() {playing=false;cancelAnimationFrame(raf);raf=0;lastFrameTime=0;updateButton();}
      function resetAnimation(){endAudioScene();stopFrame();progress=0;previewing=false;rocketVisible=false;render();updateButton();audioHint.textContent=soundEnabled?'🔊 Audio listo: despegue, viento e impacto.':'🔇 Efectos silenciados.';}
      function tick(now){
        if(!playing)return;
        const dt=lastFrameTime?Math.min(now-lastFrameTime,80):0;
        lastFrameTime=now;
        progress=Math.min(1,progress+dt/flightDurationMs*Number(speed.value));
        render();
        updateFlightAudio();
        if(progress>=1){playImpact();stopFrame();return;}
        raf=requestAnimationFrame(tick);
      }
      function changed(){
        formatValues();keepCameraStable();
        if(!playing)rocketVisible=false;
        if(progress>=1){progress=0;}
        if(!playing && progress===0)previewing=true;
        // Preserve animation progress/audio while dragging. Draw every slider 'input' event.
        render();updateButton();
        if(playing)updateFlightAudio();
      }
      [velocity,angle,gravity].forEach(el=>el.addEventListener('input',changed));
      targetHeight.addEventListener('input',()=>{
        const theta=Number(angle.value)*Math.PI/180,g=Number(gravity.value);
        const v=Math.sqrt(2*g*Number(targetHeight.value))/Math.sin(theta);
        velocity.value=String(Math.min(Number(velocity.max),Math.max(Number(velocity.min),v)));
        changed();
      });
      targetTime.addEventListener('input',()=>{
        const theta=Number(angle.value)*Math.PI/180,g=Number(gravity.value);
        const v=g*Number(targetTime.value)/(2*Math.sin(theta));
        velocity.value=String(Math.min(Number(velocity.max),Math.max(Number(velocity.min),v)));
        changed();
      });
      document.querySelectorAll('[data-gravity]').forEach(btn=>btn.addEventListener('click',()=>{gravity.value=btn.dataset.gravity;changed();}));
      fitGraphBtn.addEventListener('click',()=>{reframeCamera();render();});
      launchBtn.addEventListener('click',()=>{
        if(playing){endAudioScene();stopFrame();audioHint.textContent='⏸ Simulación y sonido en pausa.';return;}
        const newLaunch=progress<=0||progress>=1;
        if(progress>=1)progress=0;
        if(newLaunch)flightDurationMs=Math.min(14000,Math.max(1700,values.T*860));
        rocketVisible=true;
        previewing=false;
        startFlightAudio(newLaunch);
        playing=true;lastFrameTime=0;updateButton();render();raf=requestAnimationFrame(tick);
      });
      resetBtn.addEventListener('click',resetAnimation);
      formatValues();reframeCamera();updateButton();
      if('ResizeObserver' in window){new ResizeObserver(setupCanvas).observe($('graphWrap'));}else{window.addEventListener('resize',setupCanvas);}
      requestAnimationFrame(setupCanvas);

      const menuToggle=$('menuToggle'), navLinks=$('navLinks');
      menuToggle.addEventListener('click',()=>{
        const open=navLinks.classList.toggle('open');menuToggle.setAttribute('aria-expanded',String(open));
        menuToggle.setAttribute('aria-label',open?'Cerrar menú':'Abrir menú');
      });
      navLinks.querySelectorAll('a').forEach(a=>a.addEventListener('click',()=>{navLinks.classList.remove('open');menuToggle.setAttribute('aria-expanded','false');}));
      if('IntersectionObserver' in window){
        const revealObs=new IntersectionObserver(entries=>entries.forEach(e=>{if(e.isIntersecting){e.target.classList.add('visible');revealObs.unobserve(e.target);}}),{threshold:.08});
        document.querySelectorAll('.reveal').forEach(el=>revealObs.observe(el));
      }else{document.querySelectorAll('.reveal').forEach(el=>el.classList.add('visible'));}
      if('IntersectionObserver' in window){
        const linkObs=new IntersectionObserver(entries=>entries.forEach(e=>{if(e.isIntersecting){document.querySelectorAll('.nav-links a').forEach(a=>a.classList.toggle('active',a.getAttribute('href')==='#'+e.target.id));}}),{rootMargin:'-28% 0px -64% 0px'});
        document.querySelectorAll('main section[id]').forEach(section=>linkObs.observe(section));
      }
    })();
