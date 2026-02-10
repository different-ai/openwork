# WiNEX Spark Processor

基于 Apache Spark 2.0 的医疗门诊大数据处理模块

## 功能特性

- 多数据源接入（JSON, CSV, Parquet）
- 可配置的数据清洗和验证
- 数据转换（添加列、重命名、删除）
- Parquet 列式存储输出
- 分区写入支持
- YAML 配置驱动

## 技术栈

- Apache Spark 2.4.8
- Scala 2.11.12
- Java 8
- Maven 3.x

## 快速开始

### 构建项目

```bash
mvn clean package
```

### 运行作业

```bash
spark-submit \
  --class com.winning.spark.SparkJob \
  --master local[*] \
  target/spark-processor-1.0.0.jar
```

### 配置说明

编辑 `src/main/resources/application.yml` 配置数据源和处理规则。

## 模块架构

```
com.winning.spark
├── config          # 配置管理
├── datasource      # 数据源接入
├── processor       # 数据处理
├── output          # 数据输出
├── model           # 数据模型
└── SparkJob.scala  # 主程序入口
```

## TFS 关联

- Work Item: #1211642
- Project: WiNEX-Outpatient

## License

Copyright (c) 2025 卫宁健康科技集团股份有限公司
