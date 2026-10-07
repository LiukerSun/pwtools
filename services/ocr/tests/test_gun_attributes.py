import json
from pathlib import Path
from gun_attributes import parse_gun_attributes
from scoreboard import OCRLine
import os
import pytest

def test_shared_panel_geometry_fixtures():
    fixture = json.loads((Path(__file__).resolve().parents[3] / 'tests/fixtures/gun-attributes.json').read_text(encoding='utf-8'))
    for case in fixture['cases']:
        lines = [OCRLine([[v['x0'],v['y0']],[v['x1'],v['y0']],[v['x1'],v['y1']],[v['x0'],v['y1']]],v['text'],v['confidence']) for v in case['lines']]
        result = parse_gun_attributes(lines, fixture['width'], fixture['height'])
        assert result['values'] == case['values'], case['name']
        assert result['status'] == case['status'], case['name']
        assert len(result['warnings']) == case['warnings'], case['name']
        assert 'raw_text' not in result

def test_both_routes_share_one_worker():
    import threading
    from fastapi.testclient import TestClient
    from app import create_app
    from test_app import png, fake_recognition
    started, finish = threading.Event(), threading.Event()
    def recognize(_engine, _image):
        started.set()
        assert finish.wait(5)
        return parse_gun_attributes([],100,100)
    with TestClient(create_app(lambda: object(),fake_recognition,recognize)) as client:
        responses=[]
        worker=threading.Thread(target=lambda:responses.append(client.post('/recognize-build-attributes',content=png(),headers={'Content-Type':'image/png'})))
        worker.start()
        try:
            assert started.wait(3)
            busy=client.post('/recognize',content=png(),headers={'Content-Type':'image/png'})
            assert busy.status_code==503 and busy.headers['Retry-After']=='2'
        finally:
            finish.set(); worker.join()
        assert responses[0].status_code==200
        assert client.post('/recognize-build-attributes',content=b'x',headers={'Content-Type':'image/png'}).status_code==422
        assert client.post('/recognize-build-attributes',content=png(),headers={'Content-Type':'image/png','Content-Length':str(12*1024*1024+1)}).status_code==413

@pytest.mark.skipif(not os.environ.get('PWTOOLS_GUN_OCR_SAMPLE'),reason='local opt-in image, not committed')
def test_actual_gun_panel_inference():
    from app import create_app
    from fastapi.testclient import TestClient
    with TestClient(create_app()) as client:
        response=client.post('/recognize-build-attributes',content=Path(os.environ['PWTOOLS_GUN_OCR_SAMPLE']).read_bytes(),headers={'Content-Type':'image/png'})
        assert response.status_code==200
        result=response.json()
        assert result['weapon_name']=='M7战斗步枪'
        assert result['values']==dict(price=852355,damage=39,range_m=65,recoil_control=61,handling=38,stability=63,hip_fire=51,armor_damage=42,fire_rate_rpm=649,capacity=30,fire_modes=['全自动','单发'],muzzle_velocity_mps=819,sound_distance_m=600)
        assert result['missing']==[]
