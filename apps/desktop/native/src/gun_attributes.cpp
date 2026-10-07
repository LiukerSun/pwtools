#include "gun_attributes.hpp"
#include <cmath>
#include <cctype>
#include <regex>

namespace pwtools {
namespace {
using Json=nlohmann::json;
struct Field { const char* key; std::vector<std::string> labels; const char* unit=""; };
const std::vector<Field> fields{
 {"damage",{"基础伤害","肉伤"}}, {"armor_damage",{"护甲伤害","甲伤"}},
 {"range_m",{"优势射程","射程"},"米"}, {"recoil_control",{"后坐力控制","后座"}},
 {"handling",{"操控速度","操控"}}, {"stability",{"据枪稳定性","稳定性"}},
 {"hip_fire",{"腰际射击精度","腰射"}}, {"fire_rate_rpm",{"射速"},"发/分"},
 {"capacity",{"容量"}}, {"fire_modes",{"开火模式"}},
 {"muzzle_velocity_mps",{"枪口初速"},"米/秒"}, {"sound_distance_m",{"枪声传播距离"},"米"}, {"price",{"价格"}}
};
std::string Compact(std::string text) {
 text.erase(std::remove_if(text.begin(),text.end(),[](unsigned char c){return c<128 && std::isspace(c);}),text.end());
 for (const auto& pair: {std::pair<std::string,std::string>{"，",","},{"／","/"},{"　",""}}) {
  size_t pos=0; while((pos=text.find(pair.first,pos))!=std::string::npos){text.replace(pos,pair.first.size(),pair.second); pos+=pair.second.size();}
 }
 return text;
}
Json Value(const Field& field, std::string text) {
 text=Compact(std::move(text));
 if(std::string(field.key)=="fire_modes") {
  Json modes=Json::array(); size_t start=0;
  do { const auto end=text.find('/',start); const auto mode=text.substr(start,end==std::string::npos?end:end-start);
   if(mode!="全自动" && mode!="单发" && mode!="点射")return nullptr;
   if(std::find(modes.begin(),modes.end(),Json(mode))==modes.end())modes.push_back(mode);
   if(end==std::string::npos)break; start=end+1;
  }while(start<=text.size());
  return modes;
 }
 const std::string unit=field.unit;
 if(!unit.empty() && text.ends_with(unit))text.resize(text.size()-unit.size());
 static const std::regex numeric(R"((?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?)");
 if(!std::regex_match(text,numeric))return nullptr;
 text.erase(std::remove(text.begin(),text.end(),','),text.end());
 double number;
 try {number=std::stod(text);}catch(...){return nullptr;}
 const std::string key=field.key;
 if(!std::isfinite(number) || number>(key=="price"?9000000000000.0:1000000.0))return nullptr;
 if((key=="capacity" || key=="price" || key=="fire_rate_rpm") && std::floor(number)!=number)return nullptr;
 return std::floor(number)==number?Json(static_cast<int64_t>(number)):Json(number);
}
}
Json ParseGunAttributes(const std::vector<OcrLine>& lines, double, double) {
 Json values=Json::object(), confidence=Json::object(),warnings=Json::array(),missing=Json::array(),weapon=nullptr;
 for(const auto& line:lines) {
  const auto text=Compact(line.text);
  bool gun=false; for(const std::string suffix:{"步枪","冲锋枪","机枪","霰弹枪","手枪","狙击枪"})if(text.ends_with(suffix) && text.size()>suffix.size() && text.size()<=300)gun=true;
  if(gun){ if(!weapon.is_null() && weapon!=text){weapon=nullptr;warnings.push_back("识别到多个枪名，请核对武器名称。");break;} weapon=text; }
 }
 for(size_t index=0;index<fields.size();++index) {
  const auto& field=fields[index]; std::vector<std::pair<Json,double>> candidates;
  for(const auto& line:lines) {
   const auto text=Compact(line.text); std::string label;
   for(const auto& alias:field.labels)if(text.starts_with(alias)){label=alias;break;}
   if(label.empty())continue;
   auto tail=text.substr(label.size()); if(tail.starts_with("："))tail.erase(0,std::string("：").size());else if(tail.starts_with(':'))tail.erase(0,1);
   if(!tail.empty()){auto value=Value(field,tail);if(!value.is_null())candidates.emplace_back(value,line.confidence);continue;}
   for(const auto& right:lines) {
    if(&right==&line || right.x0<line.x1-4 || std::abs(right.Cy()-line.Cy())>std::max(line.Height(),right.Height())*.55)continue;
    auto value=Value(field,right.text);if(!value.is_null())candidates.emplace_back(value,std::min(line.confidence,right.confidence));
   }
  }
  if(candidates.size()==1){values[field.key]=candidates[0].first;confidence[field.key]=candidates[0].second;if(candidates[0].second<.8)warnings.push_back(field.labels[0]+"识别置信度较低，请核对。");}
  else if(candidates.size()>1)warnings.push_back(field.labels[0]+"存在重复或冲突值，请手工填写。");
  if(index<8 && !values.contains(field.key))missing.push_back(field.key);
 }
 const auto status=lines.empty()?"no_text":missing.size()<8?"completed":"no_fields";
 return Json{{"status",status},{"weapon_name",weapon},{"values",values},{"confidences",confidence},{"warnings",warnings},{"missing",missing}};
}
}
