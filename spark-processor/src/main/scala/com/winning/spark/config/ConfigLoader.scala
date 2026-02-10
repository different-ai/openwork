package com.winning.spark.config

import org.yaml.snakeyaml.Yaml
import scala.collection.JavaConverters._
import scala.util.{Try, Success, Failure}

object ConfigLoader {
  
  def load(configPath: String = "application.yml"): AppConfig = {
    val yaml = new Yaml()
    val inputStream = Option(getClass.getClassLoader.getResourceAsStream(configPath))
    
    inputStream match {
      case None =>
        println(s"Config file not found: $configPath, using defaults")
        AppConfig(
          spark = SparkConfig(),
          datasource = DatasourceConfig("json", ""),
          processor = ProcessorConfig(),
          output = OutputConfig()
        )
      case Some(stream) =>
        try {
          val configMap = yaml.load(stream).asInstanceOf[java.util.Map[String, Any]]
          parseConfig(configMap.asScala.toMap)
        } finally {
          stream.close()
        }
    }
  }
  
  private def parseConfig(map: Map[String, Any]): AppConfig = {
    AppConfig(
      spark = parseSparkConfig(getNestedMap(map, "spark")),
      datasource = parseDatasourceConfig(getNestedMap(map, "datasource")),
      processor = parseProcessorConfig(getNestedMap(map, "processor")),
      output = parseOutputConfig(getNestedMap(map, "output"))
    )
  }
  
  private def getNestedMap(map: Map[String, Any], key: String): Map[String, Any] = {
    map.get(key) match {
      case Some(m: java.util.Map[_, _]) => m.asInstanceOf[java.util.Map[String, Any]].asScala.toMap
      case _ => Map.empty
    }
  }
  
  private def parseSparkConfig(map: Map[String, Any]): SparkConfig = {
    val appMap = getNestedMap(map, "app")
    SparkConfig(
      appName = appMap.getOrElse("name", "WiNEX-Spark-Processor").toString,
      master = appMap.getOrElse("master", "local[*]").toString,
      parallelism = Try(appMap.getOrElse("parallelism", 100).toString.toInt).getOrElse(100)
    )
  }
  
  private def parseDatasourceConfig(map: Map[String, Any]): DatasourceConfig = {
    DatasourceConfig(
      `type` = map.getOrElse("type", "json").toString,
      path = map.getOrElse("path", "").toString,
      options = parseOptions(map.get("options"))
    )
  }
  
  private def parseProcessorConfig(map: Map[String, Any]): ProcessorConfig = {
    ProcessorConfig(
      validation = parseValidationConfig(getNestedMap(map, "validation")),
      cleaning = parseCleaningConfig(getNestedMap(map, "cleaning")),
      transformation = parseTransformationRules(map.get("transformation"))
    )
  }
  
  private def parseValidationConfig(map: Map[String, Any]): ValidationConfig = {
    ValidationConfig(
      enabled = Try(map.getOrElse("enabled", true).toString.toBoolean).getOrElse(true),
      rules = parseValidationRules(map.get("rules"))
    )
  }
  
  private def parseCleaningConfig(map: Map[String, Any]): CleaningConfig = {
    CleaningConfig(
      enabled = Try(map.getOrElse("enabled", true).toString.toBoolean).getOrElse(true),
      trimWhitespace = Try(map.getOrElse("trimWhitespace", true).toString.toBoolean).getOrElse(true),
      removeDuplicates = Try(map.getOrElse("removeDuplicates", true).toString.toBoolean).getOrElse(true)
    )
  }
  
  private def parseValidationRules(rulesOpt: Option[Any]): List[ValidationRule] = {
    rulesOpt match {
      case Some(rules: java.util.List[_]) =>
        rules.asScala.toList.flatMap {
          case rule: java.util.Map[_, _] =>
            val r = rule.asInstanceOf[java.util.Map[String, Any]].asScala.toMap
            Some(ValidationRule(
              field = r.getOrElse("field", "").toString,
              required = Try(r.getOrElse("required", false).toString.toBoolean).getOrElse(false),
              pattern = r.get("pattern").map(_.toString),
              min = r.get("min").flatMap(v => Try(v.toString.toDouble).toOption),
              max = r.get("max").flatMap(v => Try(v.toString.toDouble).toOption)
            ))
          case _ => None
        }
      case _ => Nil
    }
  }
  
  private def parseTransformationRules(rulesOpt: Option[Any]): List[TransformRule] = {
    rulesOpt match {
      case Some(rules: java.util.List[_]) =>
        rules.asScala.toList.flatMap {
          case rule: java.util.Map[_, _] =>
            val r = rule.asInstanceOf[java.util.Map[String, Any]].asScala.toMap
            Some(TransformRule(
              `type` = r.getOrElse("type", "").toString,
              name = r.getOrElse("name", "").toString,
              value = r.getOrElse("value", "").toString
            ))
          case _ => None
        }
      case _ => Nil
    }
  }
  
  private def parseOptions(optionsOpt: Option[Any]): Map[String, String] = {
    optionsOpt match {
      case Some(options: java.util.Map[_, _]) =>
        options.asInstanceOf[java.util.Map[String, String]].asScala.toMap
      case _ => Map.empty
    }
  }
  
  private def parseOutputConfig(map: Map[String, Any]): OutputConfig = {
    OutputConfig(
      `type` = map.getOrElse("type", "parquet").toString,
      path = map.getOrElse("path", "/tmp/output").toString,
      mode = map.getOrElse("mode", "overwrite").toString,
      partitionBy = parseStringList(map.get("partitionBy"))
    )
  }
  
  private def parseStringList(listOpt: Option[Any]): List[String] = {
    listOpt match {
      case Some(list: java.util.List[_]) =>
        list.asScala.toList.map(_.toString)
      case _ => Nil
    }
  }
}
