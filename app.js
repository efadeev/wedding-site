/* ---------- Countdown ---------- */
(function(){
  var target = new Date('2026-09-05T15:00:00+03:00').getTime();
  var els = {
    d: document.getElementById('cd-days'),
    h: document.getElementById('cd-hours'),
    m: document.getElementById('cd-mins'),
    s: document.getElementById('cd-secs')
  };
  function pad(n){return (n<10?'0':'')+n;}
  function tick(){
    var diff = target - Date.now();
    if(diff <= 0){
      els.d.textContent='00';els.h.textContent='00';
      els.m.textContent='00';els.s.textContent='00';
      return;
    }
    var s=Math.floor(diff/1000);
    els.d.textContent = Math.floor(s/86400);
    els.h.textContent = pad(Math.floor(s%86400/3600));
    els.m.textContent = pad(Math.floor(s%3600/60));
    els.s.textContent = pad(s%60);
  }
  tick();
  setInterval(tick,1000);
})();

/* ---------- Reveal on scroll ---------- */
(function(){
  var items = document.querySelectorAll('.reveal');
  if(!('IntersectionObserver' in window)){
    items.forEach(function(i){i.classList.add('in');});
    return;
  }
  var io = new IntersectionObserver(function(entries){
    entries.forEach(function(e){
      if(e.isIntersecting){e.target.classList.add('in');io.unobserve(e.target);}
    });
  },{threshold:.12});
  items.forEach(function(i){io.observe(i);});
})();

/* ---------- Form logic ---------- */
(function(){
  var form = document.getElementById('rsvp-form');
  var attendBlock = document.getElementById('attend-block');
  var plusOneNameField = document.getElementById('plusone-name-field');

  // toggle attend block
  form.querySelectorAll('input[name="attending"]').forEach(function(r){
    r.addEventListener('change', function(){
      var coming = this.value === 'yes';
      attendBlock.classList.toggle('hidden', !coming);
    });
  });

  // toggle +1 name
  form.querySelectorAll('input[name="plusone"]').forEach(function(r){
    r.addEventListener('change', function(){
      plusOneNameField.classList.toggle('hidden', this.value !== 'yes');
    });
  });

  var submitBtn = form.querySelector('.btn');

  form.addEventListener('submit', function(e){
    e.preventDefault();

    var data = new FormData(form);
    var name = (data.get('name')||'').trim();
    var attending = data.get('attending');

    if(!name){ alert('Пожалуйста, укажите ваше имя.'); return; }
    if(!attending){ alert('Пожалуйста, отметьте, сможете ли вы присутствовать.'); return; }

    var payload = {
      name: name,
      attending: attending,
      plusone: data.get('plusone') || 'no',
      plusone_name: (data.get('plusone_name')||'').trim(),
      food: data.getAll('food'),
      drink: data.getAll('drink'),
      allergies: (data.get('allergies')||'').trim(),
      message: (data.get('message')||'').trim()
    };

    submitBtn.disabled = true;
    var prevLabel = submitBtn.textContent;
    submitBtn.textContent = 'Отправляем…';

    fetch('/api/rsvp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    .then(function(res){
      return res.json().catch(function(){ return {}; }).then(function(body){
        if(!res.ok || !body.ok){
          throw new Error((body && body.error) || 'Ошибка сервера. Попробуйте позже.');
        }
        return body;
      });
    })
    .then(function(){
      showThanks(name, attending);
    })
    .catch(function(err){
      submitBtn.disabled = false;
      submitBtn.textContent = prevLabel;
      alert(err.message || 'Не удалось отправить ответ. Попробуйте ещё раз.');
    });
  });

  function showThanks(name, attending){
    form.classList.add('hidden');
    var thanks = document.getElementById('thanks');
    var txt = document.getElementById('thanks-text');
    if(attending === 'yes'){
      txt.textContent = name + ', мы очень рады, что вы будете с нами! С нетерпением ждём встречи 5 сентября.';
    } else {
      txt.textContent = name + ', спасибо, что сообщили. Нам будет вас не хватать — обнимаем!';
    }
    thanks.classList.remove('hidden');
    thanks.scrollIntoView({behavior:'smooth',block:'center'});
  }
})();
