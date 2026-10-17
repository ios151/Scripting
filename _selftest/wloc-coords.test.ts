// 坐标解析自测：链接里的坐标系判定、换算、值域校验。
//
//   npx -y -p tsx tsx _selftest/wloc-coords.test.ts
//
// 这一块以前没有任何测试，而它错了的后果是**静默定位到几百米外**——不报错、
// 不卡住，只是位置不对，排查起来最费劲。百度（BD-09）和明确标了 wgs84 的链接
// 都需要换算，漏换就差 300–500 米。
//
// 只用完整链接和纯文本，不碰短链：短链要联网展开，那是另一回事。

import {
  coordinateReadout,
  formatLatLng,
  parseAndConvert,
} from "../WLOC 虚拟定位/utils/coords";
import { distanceBetween } from "../WLOC 虚拟定位/core/geo";

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    passed += 1;
    console.log(`  ok  ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${name}${detail ? `  ${detail}` : ""}`);
  }
}

async function main() {
  // 天安门一带，用来观察换算幅度。坐标是公开地标，不涉及任何人的位置。
  const LAT = 39.915001;
  const LON = 116.404001;

  console.log("[坐标系判定]");
  {
    // 苹果 / 高德本来就是地图系（GCJ-02），不该动
    const apple = await parseAndConvert(`https://maps.apple.com/?ll=${LAT},${LON}`);
    check(
      "苹果链接原样保留",
      Math.abs(apple.latitude - LAT) < 1e-6 && Math.abs(apple.longitude - LON) < 1e-6,
      `${apple.latitude},${apple.longitude}`,
    );

    const amap = await parseAndConvert(`https://uri.amap.com/marker?q=${LAT},${LON},测试点`);
    check("高德链接原样保留", Math.abs(amap.latitude - LAT) < 1e-6);
    check("高德链接带出名称", amap.name === "测试点", amap.name);
  }

  console.log("\n[百度 BD-09 要换算]");
  {
    const baidu = await parseAndConvert(
      `https://api.map.baidu.com/marker?location=${LAT},${LON}&title=测试`,
    );
    const moved = distanceBetween(
      { latitude: LAT, longitude: LON },
      { latitude: baidu.latitude, longitude: baidu.longitude },
    );
    // BD-09 → GCJ-02 在北京一带约 400–600 米。只要确实挪了、且幅度在这个量级，
    // 就说明换算真的跑了（不验精确值，免得把测试绑死在实现细节上）。
    check("BD-09 被换算过", moved > 200 && moved < 1500, `位移 ${moved.toFixed(0)} m`);
    check("百度链接带出名称", baidu.name === "测试", baidu.name);

    // 同样的参数名出现在别处不能当百度处理
    const notBaidu = await parseAndConvert(`https://example.com/?location=${LON},${LAT}`);
    const stay = distanceBetween(
      { latitude: LAT, longitude: LON },
      { latitude: notBaidu.latitude, longitude: notBaidu.longitude },
    );
    check("非百度域名不按 BD-09 处理", stay < 1, `位移 ${stay.toFixed(1)} m`);
  }

  console.log("\n[显式 wgs84]");
  {
    const wgs = await parseAndConvert(
      `https://example.com/?position=${LAT},${LON}&coord_type=wgs84`,
    );
    const moved = distanceBetween(
      { latitude: LAT, longitude: LON },
      { latitude: wgs.latitude, longitude: wgs.longitude },
    );
    // WGS-84 → GCJ-02 在北京约 300–600 米
    check("标了 wgs84 的被换算", moved > 100 && moved < 1500, `位移 ${moved.toFixed(0)} m`);
  }

  console.log("\n[值域校验]");
  {
    let rejected = false;
    try {
      // 纬度 95 不存在
      await parseAndConvert("95.123456, 116.404000");
    } catch {
      rejected = true;
    }
    check("超范围的纬度被拒", rejected);

    // 经纬顺序颠倒时应该认出来：纬度不可能 >90
    const flipped = await parseAndConvert("116.404000, 39.915000");
    check(
      "经纬顺序颠倒能纠正",
      Math.abs(flipped.latitude - 39.915) < 1e-5,
      `${flipped.latitude},${flipped.longitude}`,
    );
  }

  console.log("\n[纯文本]");
  {
    const text = await parseAndConvert("39.915000,116.404000");
    check("纯文本按地图系原样取用", Math.abs(text.latitude - LAT) < 1e-6);

    let noCoord = false;
    try {
      await parseAndConvert("这段话里没有坐标");
    } catch {
      noCoord = true;
    }
    check("没有坐标时报错", noCoord);
  }

  console.log("\n[卡片上的两套坐标]");
  {
    // 境内：地图系和下发给设备的值必须不同，差值就是 GCJ-02 的偏移
    const cn = coordinateReadout(LAT, LON);
    check("境内认定两系不同", cn.same === false);
    check(
      "地图系原样保留（卡片上点的就是它）",
      Math.abs(cn.map.latitude - LAT) < 1e-6 && Math.abs(cn.map.longitude - LON) < 1e-6,
      `${cn.map.latitude},${cn.map.longitude}`,
    );
    const offset = distanceBetween(cn.map, cn.wgs84);
    check("WGS-84 确实挪开了", offset > 100 && offset < 1500, `偏移 ${offset.toFixed(0)} m`);

    /*
      境外必须判成「两系一致」。

      GCJ-02 的偏移只在中国境内存在，境外换算是原样返回。要是这里判成不同，
      卡片就会并排列出两行一模一样的数字、各标一个坐标系名——无中生有的区别，
      比不显示更糟。坐标取埃菲尔铁塔，公开地标。
    */
    const fr = coordinateReadout(48.858400, 2.294500);
    check("境外认定两系一致", fr.same === true);
    check(
      "境外两套值真的相等",
      fr.map.latitude === fr.wgs84.latitude && fr.map.longitude === fr.wgs84.longitude,
      `${fr.map.latitude},${fr.map.longitude} vs ${fr.wgs84.latitude},${fr.wgs84.longitude}`,
    );

    // 复制出去的那串：纬在前、经在后、六位小数
    check(
      "格式化是「纬度, 经度」六位小数",
      formatLatLng(32.0440771, 118.7849018) === "32.044077, 118.784902",
      formatLatLng(32.0440771, 118.7849018),
    );
  }

  console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
  if (failed > 0) process.exit(1);
}

void main();
